import { open, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import Negotiator from "negotiator";
import { parseRequestTarget } from "./legacy/safe-path";

/** The static site's own cache lifetime: every page and asset is `public, max-age=60`. */
export const SITE_MAX_AGE_MS = 60_000;

/**
 * The public site compresses each text file once, when it writes it (apps/public-site
 * precompress.ts): `<file>.br` and `<file>.gz` sit beside it, stamped with the page's own mtime.
 * These helpers serve those copies.
 */

/**
 * A companion belongs to the page whose mtime it carries (the writer stamps it; utimes keeps whole
 * milliseconds, hence 1 ms). Any other mtime, newer or older, means it was made from some other
 * version of the page: a restore that kept an older timestamp, an edit in place, a rewrite in
 * progress. Same rule as precompress.ts's MTIME_TOLERANCE_MS.
 */
const MTIME_TOLERANCE_MS = 1;

/** Same candidates and preference as compress.ts's `compression`: brotli, then gzip, then the rest. */
const SUPPORTED = ["br", "gzip", "deflate", "identity"];
const PREFERRED = ["br", "gzip"];
const COMPANION_EXT: Record<string, string> = { br: ".br", gzip: ".gz" };

/** Express `res.type` for the file's extension, as express.static would send it. */
function contentTypeOf(res: Response, file: string): string {
  const keep = res.getHeader("Content-Type");
  res.type(extname(file));
  const type = String(res.getHeader("Content-Type"));
  if (keep === undefined) res.removeHeader("Content-Type");
  else res.setHeader("Content-Type", keep);
  return type;
}

/** `send`'s If-Match / If-Unmodified-Since check, against this variant's validators. */
function preconditionFails(req: Request, etag: string, lastModified: string): boolean {
  const match = req.headers["if-match"];
  if (match) {
    return match !== "*" && match.split(",").map((t) => t.trim()).filter(Boolean).every((m) => m !== etag && m !== `W/${etag}` && `W/${m}` !== etag);
  }
  const since = Date.parse(req.headers["if-unmodified-since"] ?? "");
  if (!Number.isNaN(since)) return Date.parse(lastModified) > since;
  return false;
}

/** Records every header it sets so all of them can be put back as they were. */
function headerJournal(res: Response) {
  const before = new Map<string, ReturnType<Response["getHeader"]>>();
  return {
    set(name: string, value: string | number | readonly string[]): void {
      const key = name.toLowerCase();
      if (!before.has(key)) before.set(key, res.getHeader(name));
      res.setHeader(name, value);
    },
    undo(): void {
      for (const [name, value] of before) {
        if (value === undefined) res.removeHeader(name);
        else res.setHeader(name, value);
      }
    },
  };
}

/**
 * Answers from an open companion. Headers go on only now, after the file is open and its own fstat
 * says it is current, and they come off again if the first read fails before any byte is sent: the
 * response is then false and the caller's identity path starts from the headers it had. Same
 * semantics as express.static / send for what it does handle: Cache-Control (unless already set),
 * Last-Modified, a 304 for a fresh conditional GET/HEAD on a 2xx (without the content headers),
 * HEAD with the length and no body. An If-Match / If-Unmodified-Since that fails is handed to the
 * identity path, as before (send's 412 used to fall through to it too).
 */
async function respondFrom(
  req: Request,
  res: Response,
  handle: FileHandle,
  copy: Stats,
  encoding: string,
  ext: string,
  type: string,
  extra: Record<string, string> | undefined,
): Promise<boolean> {
  const etag = `W/"${copy.size.toString(16)}-${Math.floor(copy.mtimeMs).toString(16)}-${ext.slice(1)}"`;
  const lastModified = copy.mtime.toUTCString();
  if (preconditionFails(req, etag, lastModified)) {
    await handle.close().catch(() => {});
    return false;
  }
  const h = headerJournal(res);
  try {
    // res.vary merges into any existing Vary; recorded so undo puts the original back.
    h.set("Vary", res.getHeader("Vary") ?? "");
    res.vary("Accept-Encoding");
    h.set("Content-Type", type);
    h.set("Content-Encoding", encoding);
    h.set("ETag", etag);
    for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
    if (!res.getHeader("Cache-Control")) h.set("Cache-Control", `public, max-age=${Math.floor(SITE_MAX_AGE_MS / 1000)}`);
    if (!res.getHeader("Last-Modified")) h.set("Last-Modified", lastModified);

    if (req.fresh) {
      for (const name of ["Content-Encoding", "Content-Language", "Content-Length", "Content-Range", "Content-Type"]) res.removeHeader(name);
      res.status(304).end();
      await handle.close().catch(() => {});
      return true;
    }
    h.set("Content-Length", copy.size);
    if (req.method === "HEAD") {
      res.end();
      await handle.close().catch(() => {});
      return true;
    }
  } catch (err) {
    h.undo();
    await handle.close().catch(() => {});
    throw err;
  }

  // The bytes of this handle, exactly the fstat'ed size: a rename over the companion meanwhile
  // doesn't change what this open file holds. autoClose closes the handle on end, error or destroy.
  const stream = handle.createReadStream({ start: 0, end: copy.size - 1, autoClose: true });
  return await new Promise<boolean>((resolveSent) => {
    let settled = false;
    const settle = (sent: boolean): void => {
      if (settled) return;
      settled = true;
      resolveSent(sent);
    };
    stream.on("error", (err) => {
      stream.unpipe(res);
      stream.destroy();
      if (!res.headersSent) {
        h.undo(); // nothing sent yet: the caller serves the page as if there were no stored copy
        settle(false);
        return;
      }
      res.destroy(err); // mid-body: the client sees a cut-off response, never a mislabelled one
      settle(true);
    });
    res.on("close", () => {
      stream.destroy(); // done, or the client went away: stop reading, release the handle
      settle(true);
    });
    res.on("finish", () => settle(true));
    stream.pipe(res);
  });
}

/**
 * Serves `<rel>.br` or `<rel>.gz` for `rel` (a path under `outputDir`) when the client accepts it
 * and the stored copy opens and carries the page's own mtime. Resolves true when it took the
 * response, false when the caller should serve the identity file as it always did; when false, no
 * header it would have set is left on `res`. The companion is opened first and checked through the
 * open handle (fstat), so a copy deleted, replaced, locked or unreadable at that moment is simply
 * not used, and the ETag and Content-Length describe the bytes actually streamed. An encoded
 * response carries the original's Content-Type, `Content-Encoding`, `Vary: Accept-Encoding`, the
 * site's Cache-Control (or `headers`' own), its own Content-Length and a weak ETag that names the
 * encoding, so a cache or conditional request never mixes variants. A Range request is not served
 * here (a byte range of an encoded body means nothing to a client that asked for the page's
 * bytes): the identity file answers it.
 */
export async function sendPrecompressed(
  req: Request,
  res: Response,
  outputDir: string,
  rel: string,
  opts: { headers?: Record<string, string>; contentType?: string | null } = {},
): Promise<boolean> {
  if (req.headers.range !== undefined) return false;
  if (req.headers["accept-encoding"] === undefined) return false;
  if (res.headersSent) return false;
  const root = resolve(outputDir);
  const pagePath = resolve(root, rel);
  if (!pagePath.startsWith(root + sep)) return false; // parseRequestTarget already refuses .. ; belt and braces
  const ranked = new Negotiator(req).encodings(SUPPORTED, { preferred: PREFERRED });
  let page;
  try {
    page = await stat(pagePath);
  } catch {
    return false;
  }
  if (!page.isFile()) return false;
  for (const encoding of ranked) {
    const ext = COMPANION_EXT[encoding];
    if (ext === undefined) return false; // the client prefers identity or deflate: not ours to improve
    let handle: FileHandle;
    try {
      handle = await open(`${pagePath}${ext}`, "r");
    } catch {
      continue; // gone, locked or unreadable right now (maybe the other encoding opens)
    }
    let copy: Stats;
    try {
      copy = await handle.stat();
    } catch {
      await handle.close().catch(() => {});
      continue;
    }
    // Made from this version of the page, and a sane size (a companion is only written when smaller).
    if (!copy.isFile() || Math.abs(copy.mtimeMs - page.mtimeMs) > MTIME_TOLERANCE_MS || copy.size === 0 || copy.size >= page.size) {
      await handle.close().catch(() => {});
      continue;
    }
    const type = opts.contentType ?? contentTypeOf(res, rel);
    return await respondFrom(req, res, handle, copy, encoding, ext, type, opts.headers);
  }
  return false;
}

/**
 * Before `express.static` on the site's chains: answers a GET/HEAD for a page or asset from its
 * stored `.br`/`.gz` copy (`sendPrecompressed`). Anything else (no such copy, a stale one, a
 * directory redirect, a dot file, a Range request, a client that wants identity) falls through
 * to express.static, and its response is compressed per request by compress.ts as before.
 * `typeOf` is the site's own Content-Type override (feed types), null for the default.
 */
export function servePrecompressed(outputDir: string, typeOf: (file: string) => string | null): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const target = parseRequestTarget(req.url);
    if (!target) return next();
    const segments = target.path.split("/").slice(1);
    if (segments.some((s) => s.startsWith("."))) return next(); // dotfiles: deny, as express.static does
    const rel = target.path.endsWith("/") ? `${segments.slice(0, -1).join("/")}${segments.length > 1 ? "/" : ""}index.html` : segments.join("/");
    sendPrecompressed(req, res, outputDir, rel, { contentType: typeOf(rel) }).then((sent) => {
      if (!sent) next();
    }, next);
  };
}
