import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RequestHandler } from "express";
import { fixedRule } from "./rules";
import { parseRequestTarget } from "./safe-path";
import { pagePath } from "./site-files";

export interface LegacyUrlOptions {
  outputDir: string;
  /** The prefix this handler is mounted under: "" at the root, "/site" under /site. */
  basePath: string;
  /** Stack-owned path prefixes (`STACK_OWNED_PREFIXES`), passed through before any filesystem call. */
  passThrough: readonly string[];
  /** NEWS-n reference → post key (plan 3 Task 6). Unused until then. */
  lookupReference?: (reference: string) => Promise<string | null>;
}

/**
 * Old news.gov.bc.ca URLs (parity plan 3, url-compat §T1). Mounted by `mountSite` first in
 * each site chain, ahead of `ministrySuccessorRedirects` and `express.static`. Per request it:
 * - answers a no-store 301 whose Location is `${basePath}<path>` (root-relative, so the
 *   X-Forwarded-Host behind nginx or IIS/ARR never matters) and names a page that exists now; or
 * - rewrites `req.url` so the static mount serves a file in place (the legacy OG image); or
 * - falls through (`next()`) to the static mount and the site 404.
 *
 * Order: method (GET/HEAD), then `passThrough`, then `parseRequestTarget` (anything unsafe falls
 * through), then `fixedRule`. A *fallback* rule fires only when the request path is not itself a
 * page on disk, so a page the site later builds (plan 4's /releases/ …) wins with no change here.
 * Filesystem errors go to `next(err)`.
 */
export function legacyUrls(opts: LegacyUrlOptions): RequestHandler {
  const { outputDir, basePath } = opts;
  // Express matches mount paths case-insensitively (/API/x reaches /api), so this does too.
  const prefixes = opts.passThrough.map((p) => p.toLowerCase());
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const lower = req.path.toLowerCase();
    if (prefixes.some((p) => lower === p || lower.startsWith(`${p}/`))) return next();
    const target = parseRequestTarget(req.url);
    if (!target) return next();
    const action = fixedRule(target.path, target.query);
    if (!action) return next();

    (async () => {
      if (action.do === "serve") {
        let isFile = false;
        try {
          isFile = (await stat(join(outputDir, ...action.file.split("/")))).isFile();
        } catch {
          // Missing (not vendored yet) or unreadable: the site 404, never a redirect.
        }
        if (!isFile) return next();
        // express.static's `send` keeps a Content-Type that is already set.
        res.setHeader("Content-Type", action.type);
        req.url = `/${action.file}${target.query}`;
        return next();
      }

      if (action.fallback && (await pagePath(outputDir, target.path)) !== null) return next();
      let to: string | null = null;
      for (const candidate of action.to) {
        if (candidate.endsWith("!")) {
          to = candidate.slice(0, -1);
          break;
        }
        to = await pagePath(outputDir, candidate);
        if (to !== null) break;
      }
      if (to === null) return next();
      const absolute = /^https:\/\/forms\.gov\.bc\.ca\//.test(to);
      const location = `${absolute ? "" : basePath}${to}${action.query === "keep" ? target.query : ""}`;
      // Root-relative or the one forms.gov URL; never protocol-relative.
      if (!absolute && (!location.startsWith("/") || location.startsWith("//") || location.startsWith("/\\"))) return next();
      res.setHeader("Cache-Control", "no-store");
      res.redirect(action.status ?? 301, location);
    })().catch(next);
  };
}
