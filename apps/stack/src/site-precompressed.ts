import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import Negotiator from "negotiator";
import { parseRequestTarget } from "./legacy/safe-path";

/** The static site's own cache lifetime: every page and asset is `public, max-age=60`. */
export const SITE_MAX_AGE_MS = 60_000;

/**
 * The public site compresses each text file once, when it writes it (apps/public-site
 * precompress.ts): `<file>.br` and `<file>.gz` sit beside it. These helpers serve those copies.
 */

/** A companion this much older than its page still counts as current (matches the writer's slack). */
const FRESHNESS_SLACK_MS = 1;

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

/**
 * Serves `<rel>.br` or `<rel>.gz` for `rel` (a path under `outputDir`) when the client accepts it
 * and the stored copy exists and is not older than the page. Resolves true when it took the
 * response, false when the caller should serve the identity file as it always did. An encoded
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
  const ranked = new Negotiator(req).encodings(SUPPORTED, { preferred: PREFERRED });
  let page;
  try {
    page = await stat(`${outputDir}/${rel}`);
  } catch {
    return false;
  }
  if (!page.isFile()) return false;
  for (const encoding of ranked) {
    const ext = COMPANION_EXT[encoding];
    if (ext === undefined) return false; // the client prefers identity or deflate: not ours to improve
    let copy;
    try {
      copy = await stat(`${outputDir}/${rel}${ext}`);
    } catch {
      continue; // no such copy (maybe the other encoding has one)
    }
    if (!copy.isFile() || copy.mtimeMs + FRESHNESS_SLACK_MS < page.mtimeMs) continue; // stale: the page changed after it
    const type = opts.contentType ?? contentTypeOf(res, rel);
    res.vary("Accept-Encoding");
    return await new Promise<boolean>((resolve) => {
      res.sendFile(
        `${rel}${ext}`,
        {
          root: outputDir,
          dotfiles: "deny",
          acceptRanges: false,
          maxAge: SITE_MAX_AGE_MS,
          headers: { "Content-Type": type, "Content-Encoding": encoding, ETag: `W/"${copy.size.toString(16)}-${Math.floor(copy.mtimeMs).toString(16)}-${ext.slice(1)}"`, ...opts.headers },
        },
        (err) => resolve(!err || res.headersSent),
      );
    });
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
