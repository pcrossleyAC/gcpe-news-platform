import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { basename } from "node:path";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { applyFilesHeaders } from "./files-policy";
import { normalizeLegacyPath, RESERVED_FIRST_SEGMENTS } from "./legacy-files/references";
import { siteNotFound } from "./site-not-found";

/**
 * The 60 s public cache on everything `/files` serves (browser and the SiteGround/DMZ proxy).
 * It is also the worst-case time a copy of a release file can outlive the release going off
 * the site (Q17): the gate below refuses the file from the moment staff press Unpublish, and a
 * copy fetched just before can be reused by a cache for at most this long.
 */
export const FILES_MAX_AGE_MS = 60_000;

/** Carousel and emergency-pin images (apps/nrms/src/website/slide-images.ts): `slides/<sha256>.<png|jpg>`. */
const SLIDE_KEY = /^slides\/[0-9a-f]{64}\.(png|jpg)$/;

export type FileClass = { kind: "public"; key: string } | { kind: "lookup"; key: string } | { kind: "deny" };

/**
 * What NRMS's file store (`STORAGE_DIR`) holds, by key shape — every writer is in apps/nrms:
 *   - `<name>` (one segment): the Hub's general site files (website/files.ts) and their
 *     short-lived staging copies — public by design, served as before;
 *   - `slides/<sha256>.<ext>`: carousel and pin images (website/slide-images.ts) — public by
 *     design (content-addressed), served as before;
 *   - `releases/<release uuid>/<translations|assets>/<16 hex>-<name>`: release files
 *     (media/files.ts) — Q17: only while their release is live.
 * Anything else with more than one segment is treated as a release-file key and must match one
 * exactly in the database (so non-canonical spellings — another letter case, which a
 * case-insensitive file system such as Windows' or macOS' would otherwise happily resolve, a
 * doubled or dot segment, `.meta/…` — are simply not found). `rawPath` is the request path
 * under `/files`, decoded the same way express.static (send) decodes it, so the key looked up
 * is exactly the file that would be served. Backslashes, colons and NULs never occur in a key
 * and are refused, so a Windows path separator or drive/stream syntax can't reach a release
 * file through a "single segment". A segment starting with "." is refused too.
 */

/** Defence in depth for the no-lookup branches: the key must be a regular file, and no part of
 * its path a symlink or (for the last part) a directory. */
async function isRegularFile(root: string, key: string): Promise<boolean> {
  const parts = key.split("/");
  try {
    for (let i = 1; i <= parts.length; i++) {
      const st = await lstat(join(root, ...parts.slice(0, i)));
      if (st.isSymbolicLink()) return false;
      if (i === parts.length ? !st.isFile() : !st.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}
export function classifyFilePath(rawPath: string): FileClass {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return { kind: "deny" };
  }
  if (!path.startsWith("/") || path.length < 2 || /[\\:\0]/.test(path)) return { kind: "deny" };
  const key = path.slice(1);
  // Dot segments: the store's own `.meta` folder, `.`/`..`. express.static would answer 403
  // (dotfiles: "deny") or refuse them; here they are the same 404 as any unknown key.
  if (key.split("/").some((s) => s.startsWith("."))) return { kind: "deny" };
  // Windows aliases: an 8.3 short name (NEWS_F~1.PDF) or a trailing dot or space opens the real
  // file there, past every check on the name. No storage key contains `~` or ends that way.
  if (key.split("/").some((s) => s.includes("~") || /[. ]$/.test(s))) return { kind: "deny" };
  if (!key.includes("/") || SLIDE_KEY.test(key)) return { kind: "public", key };
  return { kind: "lookup", key };
}

export interface FilesMountOptions {
  /** NRMS's STORAGE_DIR. */
  storageDir: string;
  /** The public site's output folder, for its 404 page (site-not-found.ts). */
  outputDir: string;
  /** NRMS's `releaseFileIsPublic` (apps/nrms/src/media/files.ts `isReleaseFilePublic`). */
  isPublic: (storageKey: string) => Promise<boolean>;
  /**
   * NRMS's `findSiteFileByName` (apps/nrms/src/website/files.ts): a site file by its public name,
   * case-insensitively — how an imported legacy file whose name isn't its storage key (a space,
   * capitals) is found. Absent: only the storage key itself is served, as before.
   */
  siteFileByName?: (name: string) => Promise<{ name: string; storageKey: string } | null>;
  /**
   * The legacy safety net: where `/files/<path>` is 302'd when nothing here answers it (legacy's
   * Azure front door), or null/absent for the plain 404. Never for `releases/` or `slides/`.
   */
  fallbackOrigin?: string | null;
}

/** The policy's headers as a plain object, for res.sendFile. */
function policyHeaders(name: string): Record<string, string> {
  const headers: Record<string, string> = {};
  applyFilesHeaders({ setHeader: (k: string, v: string) => void (headers[k] = v) } as unknown as Response, name);
  return headers;
}

/** The first segment of `key` names NRMS's own namespace (any case): never a site-file name lookup or a redirect. */
function reservedForNrms(key: string): boolean {
  return RESERVED_FIRST_SEGMENTS.includes(key.split("/")[0]!.toLowerCase());
}

/** Nothing at all at `key` in NRMS's store (ENOENT/ENOTDIR): only then may a site file of another storage key answer for a single-segment name. */
async function absentFromStore(root: string, key: string): Promise<boolean> {
  try {
    await lstat(join(root, ...key.split("/")));
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

const statusOf = (err: unknown): number | undefined => {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  return typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
};

/**
 * The handlers stack.ts mounts at `/files` (`app.use("/files", ...filesHandlers(…))`, kept in
 * stack.ts so tests/stack-owned-prefixes.test.ts sees the mount): the release-file gate, the
 * static store, and one 404 for every miss.
 *
 * A release file that isn't public right now answers exactly what an unknown key answers — the
 * site's own 404 page with `Cache-Control: no-store` (siteNotFound) — so nothing tells a
 * stranger that the file exists. no-store matters as much as the body: the SiteGround proxy
 * caches any GET lacking a Cache-Control header, so a 404 cached before go-live would
 * otherwise go on hiding the file afterwards. A served file keeps express.static's own
 * `public, max-age=60` (and nosniff), exactly as before.
 *
 * Release status is one indexed database lookup per request (no in-process cache): the path is
 * behind the 60 s public cache, so a busy file costs about one lookup per minute per cache, and
 * nothing extra has to be invalidated on publish/unpublish/delete — the answer is always the
 * database's current one. A lookup that fails is a 503 (no-store), never the file.
 */
export function filesHandlers(opts: FilesMountOptions): [RequestHandler, RequestHandler, ErrorRequestHandler] {
  const notFound = siteNotFound(opts.outputDir);
  const fallbackOrigin = opts.fallbackOrigin ?? null;
  /** Nothing here answers: the 302 safety net (safe paths only), else the 404. */
  const fallbackOrNotFound: RequestHandler = (req, res, next) => {
    if (!fallbackOrigin) return notFound(req, res, next);
    const n = normalizeLegacyPath(req.url.replace(/[?#].*$/s, "").slice(1));
    if (!n.ok) return notFound(req, res, next); // unsafe or reserved: never redirected
    // To the lowercased name: legacy's Hub stored every upload under its lowercased blob name, and
    // its resolver tried that first (46 of 46 mixed-case links surveyed on 2026-10-29 answered only
    // lowercased). Each segment percent-encoded; the host is the configured origin, nothing else.
    const location = `${fallbackOrigin}/files/${n.path.toLowerCase().split("/").map(encodeURIComponent).join("/")}`;
    res.status(302).set("Cache-Control", "no-store").location(location).end();
  };
  const sendStored = (req: Request, res: Response, next: (err?: unknown) => void, storageKey: string, name: string) => {
    // root + a single-segment key: send refuses anything that would leave the folder.
    res.sendFile(storageKey, { root: opts.storageDir, maxAge: FILES_MAX_AGE_MS, dotfiles: "deny", headers: policyHeaders(name) }, (err) => {
      if (err && !res.headersSent) notFound(req, res, next);
    });
  };
  /** A single-segment name with no file at that key: a site file of that name in any case (an imported legacy file), else the fallback. */
  const bySiteFileName: RequestHandler = (req, res, next) => {
    const lookup = opts.siteFileByName;
    const name = classifyFilePath(req.path);
    if (!lookup || name.kind !== "public") return fallbackOrNotFound(req, res, next);
    lookup(name.key).then(
      async (row) => {
        if (row && !row.storageKey.includes("/") && row.storageKey !== name.key && (await isRegularFile(opts.storageDir, row.storageKey))) return sendStored(req, res, next, row.storageKey, row.name);
        if (row && row.storageKey === name.key) return notFound(req, res, next); // its own key was just checked: not a regular file
        fallbackOrNotFound(req, res, next);
      },
      (err: unknown) => {
        console.error(`[stack] site file lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.status(503).set("Cache-Control", "no-store").type("text/plain").send("Service unavailable");
      },
    );
  };
  const gate: RequestHandler = (req, res, next) => {
    // Other methods go to express.static, which refuses them (405) as before.
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const c = classifyFilePath(req.path);
    if (c.kind === "public") {
      void isRegularFile(opts.storageDir, c.key).then(async (ok) => {
        if (ok) return next();
        // Something NRMS holds under that name (a folder, a link) stays NRMS's 404; slides/ is NRMS's.
        if (!reservedForNrms(c.key) && (await absentFromStore(opts.storageDir, c.key))) return bySiteFileName(req, res, next);
        notFound(req, res, next);
      });
      return;
    }
    if (c.kind === "deny") return notFound(req, res, next);
    // Q17: a release key (releases/…, any case) is decided by NRMS alone — public only while the
    // release is live, else the plain 404; never a name lookup, never the 302.
    const nrmsOnly = reservedForNrms(c.key);
    opts.isPublic(c.key).then(
      (ok) => (ok ? next() : nrmsOnly ? notFound(req, res, next) : fallbackOrNotFound(req, res, next)),
      (err: unknown) => {
        console.error(`[stack] release file lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.status(503).set("Cache-Control", "no-store").type("text/plain").send("Service unavailable");
      },
    );
  };
  // express.static's own misses (no such file, a directory, a refused path) become the same 404.
  const staticMiss: ErrorRequestHandler = (err, req, res, next) => {
    const status = statusOf(err);
    if ((status === 404 || status === 403) && (req.method === "GET" || req.method === "HEAD") && !res.headersSent) return notFound(req, res, next);
    next(err);
  };
  return [
    gate,
    express.static(opts.storageDir, {
      index: false,
      redirect: false,
      dotfiles: "deny",
      fallthrough: false,
      maxAge: FILES_MAX_AGE_MS,
      // Type, disposition, sandbox CSP and nosniff by name (files-policy.ts): release files and
      // uploads are PDF/PNG/JPEG and stay inline; an imported legacy file of another type does not.
      setHeaders: (res, path) => applyFilesHeaders(res as unknown as Response, basename(path)),
    }),
    staticMiss,
  ];
}
