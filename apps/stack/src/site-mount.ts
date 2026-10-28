import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { noStoreOnRedirect } from "./cache-control";
import { legacyRewriteOf, legacyUrls, type LegacyUrlOptions } from "./legacy/middleware";
import { parseRequestTarget } from "./legacy/safe-path";
import { cacheMisses } from "./legacy/reference-cache";
import { siteNotFound } from "./site-not-found";

/** The static site's own cache lifetime: every page and asset is `public, max-age=60`. */
export const SITE_MAX_AGE_MS = 60_000;

/**
 * The path the public site's URL lives under, with trailing slashes stripped: "" for an origin
 * (`https://boxs.ca`, `https://boxs.ca/`), "/site" for `https://boxs.ca/site/`.
 */
export function siteBasePath(publicSiteUrl: string): string {
  return new URL(publicSiteUrl).pathname.replace(/\/+$/, "");
}

const RSS_TYPE = "application/rss+xml; charset=utf-8";
const ATOM_TYPE = "application/atom+xml; charset=utf-8";

/**
 * The legacy feed content types for every feed file the site writes: `feed.xml` / `atom.xml` at
 * the root and in each category directory, and `feeds/<kind>.xml` / `.atom.xml`. express.static
 * would send `application/xml`; subscribers' readers (and the legacy URLs served in place) expect
 * RSS and Atom types. `send` keeps a Content-Type set here. Other .xml files are left alone.
 */
export function feedContentType(filePath: string): string | null {
  const parts = filePath.split(/[\\/]/);
  const name = parts[parts.length - 1]!;
  if (name === "feed.xml") return RSS_TYPE;
  if (name === "atom.xml") return ATOM_TYPE;
  if (parts[parts.length - 2] === "feeds") {
    if (name.endsWith(".atom.xml")) return ATOM_TYPE;
    if (name.endsWith(".xml")) return RSS_TYPE;
  }
  return null;
}

/** The hashed directory long post keys live in (site-paths.ts `postDir`), any case. */
const LONG_DIR = /^\/releases\/_long(?:\/|$)/i;

/**
 * `/releases/_long/…` is served only through `legacyUrls`' rewrite of `/releases/<long key>/`
 * (`res.locals.legacyRewrite`, kind "long"): a direct request for the hashed directory, in any
 * case or encoding, is the site 404, so a long-key post has no second URL.
 */
function hashedDirGuard(outputDir: string): RequestHandler {
  const notFound = siteNotFound(outputDir);
  return (req, res, next) => {
    const target = parseRequestTarget(req.url);
    if (target && LONG_DIR.test(target.path) && legacyRewriteOf(res)?.kind !== "long") return notFound(req, res, next);
    next();
  };
}

function staticSite(outputDir: string) {
  // dotfiles: "deny" keeps the render-state marker (.site-state.json) and anything else
  // dot-prefixed unservable; noStoreOnRedirect gives express.static's own trailing-slash
  // 301 a no-store so the SiteGround proxy never caches it.
  return [hashedDirGuard(outputDir), noStoreOnRedirect, express.static(outputDir, { index: "index.html", maxAge: SITE_MAX_AGE_MS, dotfiles: "deny", setHeaders: (res, filePath) => {
    const type = feedContentType(filePath);
    if (type !== null) res.setHeader("Content-Type", type);
  } })];
}

/**
 * `/site/<rest>?<query>` → `301 /<rest>?<query>`, once the site lives at the origin: links in
 * emails already sent, bookmarks and search results keep working in one hop. The query is
 * carried byte-for-byte (taken from the mount's `req.url`, never re-encoded). GET/HEAD only; anything
 * else falls through. no-store, so a proxy never pins the redirect.
 */
export function siteAliasRedirect(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  // Mounted at "/site", so req.url is already the remainder ("/x?q", or "/" for "/site"), raw
  // bytes, never re-encoded. For an absolute-form request line Express keeps the scheme and host
  // in front of it ("http://h/x?q"); drop them so the Location is still a path on this site.
  let rest = req.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  // "/site//evil.example" or "/site/\evil.example" must never become a protocol-relative
  // Location that leaves the site: collapse any run of leading slashes/backslashes to one "/".
  rest = rest.replace(/^[/\\]+/, "/");
  if (!rest.startsWith("/")) rest = `/${rest}`; // "/site" and "/site?x" → "/" and "/?x"
  res.setHeader("Cache-Control", "no-store");
  res.redirect(301, rest);
}

/**
 * Under the `/site` alias of an origin site, after `legacyUrls`: a feed or the legacy OG image it
 * rewrote is served in place (a feed reader on an old /site/… URL keeps its feed with no hop);
 * any other rewrite (a long key's hashed page, a gone post) is undone, so `siteAliasRedirect`
 * sends the request as asked to the root and the page has one URL. No rewrite: next().
 */
function siteAliasFiles(outputDir: string): RequestHandler {
  const files = express.Router();
  files.use(...staticSite(outputDir), siteNotFound(outputDir));
  return (req, res, next) => {
    const done = legacyRewriteOf(res);
    if (done === undefined) return next();
    if (done.kind === "file") return files(req, res, next);
    req.url = done.from;
    delete res.locals.legacyRewrite;
    next();
  };
}

/**
 * Serves the static site from `outputDir` at the root and, while PUBLIC_SITE_URL still has a
 * path (`basePath`, e.g. "/site"), at that prefix too — so with today's boxs.ca env both
 * `/site/...` and `/...` serve pages. Once `basePath` is "" (the origin), `/site/...` 301s to
 * the root instead. Mount where the cacheable static mounts go (before noStoreByDefault), so
 * the static file's own Cache-Control stands.
 */
export function mountSite(
  app: express.Express,
  opts: { outputDir: string; basePath: string; passThrough?: readonly string[]; lookupReference?: LegacyUrlOptions["lookupReference"] },
): void {
  const { outputDir, basePath } = opts;
  // One negative cache for every chain (/site and the root share it).
  const lookupReference = opts.lookupReference && cacheMisses(opts.lookupReference);
  const passThrough = opts.passThrough ?? [];
  // Old news.gov.bc.ca URLs (parity plan 3) run first in each site chain, before express.static
  // (a fallback rule checks the disk itself, so a real page still wins).
  const legacy = (base: string) => legacyUrls({ outputDir, basePath: base, passThrough, lookupReference });
  if (basePath !== "") {
    // Unchanged from before the root mount: an unknown page under the prefix is the site's 404.
    // Successors are part of legacyUrls' category rule (an old ministry's page is still on disk, new-government §4).
    app.use(basePath, legacy(basePath), ...staticSite(outputDir), siteNotFound(outputDir));
  } else {
    // The remainder of /site/… goes through the same legacy rules as the root, with Locations at
    // the root, so an old URL (/site/Releases/<k>, /site/Ministries/Justice, /site/<n>, a
    // successor's ministry) reaches its page in one hop, and only to a page that exists (the
    // category rule checks the successor's page). Feeds are
    // served in place. Anything the rules leave alone 301s to the root as it was.
    app.use("/site", legacy(""), siteAliasFiles(outputDir), siteAliasRedirect);
  }
  // This root mount runs on every request (ahead of /files, /hub and every app), so its
  // noStoreOnRedirect makes ANY 3xx in the stack no-store, not only the site's own. Harmless
  // today (everything after noStoreByDefault is no-store anyway; the one new case is
  // express.static's directory redirect under /hub/assets). A route that ever wants a
  // cacheable redirect cannot get one behind this (it overwrites Cache-Control on any 3xx at
  // writeHead); it must be mounted before mountSite in stack.ts. Running on every request also
  // means one fs.stat per request that isn't a site file (/api, /hub, /stack/tick…) before it
  // falls through: negligible next to the apps' own work, so not worth a prefix skip-list here.
  const root = express.Router();
  root.use(legacy(""), ...staticSite(outputDir));
  app.use(root);
}

/**
 * The site's 404 for any GET/HEAD that nothing else served — except under a stack-owned prefix
 * (`passThrough`), whose own app keeps answering its own 404 (News API's JSON one, for /api).
 * Mount just before News API, which owns "/" and would otherwise answer every unknown page
 * with `{"error":"not found"}`.
 */
export function rootSiteNotFound(outputDir: string, passThrough: readonly string[]): RequestHandler {
  const notFound = siteNotFound(outputDir);
  // Express matches mount paths case-insensitively (/API/Posts reaches News API's /api), so
  // the pass-through test does too.
  const prefixes = passThrough.map((p) => p.toLowerCase());
  return (req, res, next) => {
    const path = req.path.toLowerCase();
    if (prefixes.some((p) => path === p || path.startsWith(`${p}/`))) return next();
    notFound(req, res, next);
  };
}
