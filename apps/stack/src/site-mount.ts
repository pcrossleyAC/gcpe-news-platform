import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { noStoreOnRedirect } from "./cache-control";
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

function staticSite(outputDir: string) {
  // dotfiles: "deny" keeps the render-state marker (.site-state.json) and anything else
  // dot-prefixed unservable; noStoreOnRedirect gives express.static's own trailing-slash
  // 301 a no-store so the SiteGround proxy never caches it.
  return [noStoreOnRedirect, express.static(outputDir, { index: "index.html", maxAge: SITE_MAX_AGE_MS, dotfiles: "deny" })];
}

/**
 * `/site/<rest>?<query>` → `301 /<rest>?<query>`, once the site lives at the origin: links in
 * emails already sent, bookmarks and search results keep working in one hop. The query is
 * carried byte-for-byte (taken from `originalUrl`, never re-encoded). GET/HEAD only; anything
 * else falls through. no-store, so a proxy never pins the redirect.
 */
export function siteAliasRedirect(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  // Mounted at "/site", so originalUrl starts with "/site" (any case) on a segment boundary.
  let rest = req.originalUrl.slice("/site".length);
  // "/site//evil.example" or "/site/\evil.example" must never become a protocol-relative
  // Location that leaves the site: collapse any run of leading slashes/backslashes to one "/".
  rest = rest.replace(/^[/\\]+/, "/");
  if (!rest.startsWith("/")) rest = `/${rest}`; // "/site" and "/site?x" → "/" and "/?x"
  res.setHeader("Cache-Control", "no-store");
  res.redirect(301, rest);
}

/**
 * Serves the static site from `outputDir` at the root and, while PUBLIC_SITE_URL still has a
 * path (`basePath`, e.g. "/site"), at that prefix too — so with today's boxs.ca env both
 * `/site/...` and `/...` serve pages. Once `basePath` is "" (the origin), `/site/...` 301s to
 * the root instead. Mount where the cacheable static mounts go (before noStoreByDefault), so
 * the static file's own Cache-Control stands.
 */
export function mountSite(app: express.Express, opts: { outputDir: string; basePath: string }): void {
  const { outputDir, basePath } = opts;
  if (basePath !== "") {
    // Unchanged from before the root mount: an unknown page under the prefix is the site's 404.
    app.use(basePath, ...staticSite(outputDir), siteNotFound(outputDir));
  } else {
    app.use("/site", siteAliasRedirect);
  }
  const root = express.Router();
  root.use(...staticSite(outputDir));
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
