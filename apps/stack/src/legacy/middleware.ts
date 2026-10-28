import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RequestHandler, Response } from "express";
import { DEFAULT_OG_IMAGE } from "../../../public-site/src/render";
import { fixedRule } from "./rules";
import { parseRequestTarget, type RequestTarget } from "./safe-path";
import { exactPagePath, pagePath, resolvePostKey } from "./site-files";

export interface LegacyUrlOptions {
  outputDir: string;
  /** The prefix this handler is mounted under: "" at the root, "/site" under /site. */
  basePath: string;
  /** Path prefixes the site leaves alone (`SITE_PASS_THROUGH` in stack.ts), passed through before any filesystem call. */
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
 * Order: method (GET/HEAD), then `parseRequestTarget` (anything unsafe falls through), then
 * `passThrough` on the decoded path — all pure, so a pass-through prefix never costs a
 * filesystem call. Then, first match wins:
 * 1. a `fixedRule` that is not a fallback;
 * 2. the post rule: `/(releases|stories|factsheets|updates)/<key>[/image][/]`, any case
 *    (`postRule`);
 * 3. the case rule: a path with uppercase that is not a page in exactly that case, whose
 *    lowercase is one (`caseRule`) — before the fallback rules, so `/Releases` reaches a built
 *    `/releases/` in one hop, also on case-sensitive Linux;
 * 4. a *fallback* `fixedRule`, which fires only when the request path is not itself a page on
 *    disk, so a page the site later builds (plan 4's /releases/ …) wins with no change here.
 * Filesystem errors go to `next(err)`.
 */
export function legacyUrls(opts: LegacyUrlOptions): RequestHandler {
  const { outputDir, basePath } = opts;
  // Express matches mount paths case-insensitively (/API/x reaches /api), so this does too.
  const prefixes = opts.passThrough.map((p) => p.toLowerCase());
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const target = parseRequestTarget(req.url);
    if (!target) return next();
    // On the decoded path, the same one the rules match (/%75pdates/x is /updates/x to them).
    const lower = target.path.toLowerCase();
    if (prefixes.some((p) => lower === p || lower.startsWith(`${p}/`))) return next();
    const action = fixedRule(target.path, target.query);
    const post = POST_PATH.exec(target.path);
    // Nothing can match a lowercase path but a fixed rule: no filesystem call for it.
    if (!action && !post && !/[A-Z]/.test(target.path)) return next();

    const redirect = (status: 301 | 302, to: string) => {
      res.setHeader("Cache-Control", "no-store");
      res.redirect(status, `${basePath}${to}`);
    };

    (async () => {
      if (action?.do === "serve") {
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

      if (action && !action.fallback) return fixedRedirect(action, target, res, next);

      if (post) {
        const done = await postRule(post, target);
        if (done === null) return next();
        if (done.status === 404) {
          // Listed but not a page (a directory a delete left empty): hand static the slash
          // form, which it 404s, so no platform answers a trailing-slash 301 to a 404 first.
          req.url = `${done.to}${target.query}`;
          return next();
        }
        return redirect(done.status, done.to);
      }

      const lower = await caseRule(outputDir, target);
      if (lower !== null) return redirect(301, lower);

      if (action && (await pagePath(outputDir, target.path)) === null) return fixedRedirect(action, target, res, next);
      return next();
    })().catch(next);
  };

  /** A `fixedRule` redirect: the first candidate that is a page (or the unconditional "!" one). */
  async function fixedRedirect(action: RedirectAction, target: RequestTarget, res: Response, next: () => void) {
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
    const absolute = action.absolute === true;
    const location = `${absolute ? "" : basePath}${to}${action.query === "keep" ? target.query : ""}`;
    // Root-relative, or the rule's own absolute https URL; never protocol-relative.
    if (absolute ? !location.startsWith("https://") : (!location.startsWith("/") || location.startsWith("//") || location.startsWith("/\\"))) return next();
    res.setHeader("Cache-Control", "no-store");
    res.redirect(action.status ?? 301, location);
  }

  /**
   * The post rule (url-compat T2). The key resolves against `releases/`'s listing (any case);
   * the canonical page `/releases/<on-disk name>/` must exist. `/image` → 302 to the default OG
   * image (a placeholder until a per-post image endpoint is worth building), query dropped; any
   * other spelling of the post → 301 to the canonical page, query kept; the canonical path
   * itself → static, checked before any stat. An unknown key → null (the site 404); a listed
   * key whose page is gone → status 404 with the canonical path to hand static.
   */
  async function postRule(m: RegExpExecArray, target: RequestTarget): Promise<{ status: 301 | 302 | 404; to: string } | null> {
    const exact = await resolvePostKey(outputDir, m[1]!);
    if (exact === null) return null;
    const canonical = `/releases/${exact}/`;
    // The hottest path: the canonical page itself goes to static with no further stat (static
    // 404s it if it is gone).
    if (m[2] === undefined && target.path === canonical) return null;
    if ((await pagePath(outputDir, canonical)) === null) return { status: 404, to: canonical };
    if (m[2] !== undefined) {
      if ((await pagePath(outputDir, DEFAULT_OG_IMAGE)) === null) return null;
      return { status: 302, to: DEFAULT_OG_IMAGE };
    }
    return { status: 301, to: `${canonical}${target.query}` };
  }
}

type RedirectAction = Extract<NonNullable<ReturnType<typeof fixedRule>>, { do: "redirect" }>;

/** `/<kind>/<key>` with an optional `/image`, one optional trailing slash, any case. */
const POST_PATH = /^\/(?:releases|stories|factsheets|updates)\/([^/]+)(\/image)?\/?$/i;

/**
 * The case rule (url-compat T2): when the path, lowercased, names a page in exactly that case
 * and the path as asked is not a page in its own case, the Location (without basePath) of that
 * page with the query kept; else null. Both sides use `exactPagePath`, so a case-insensitive
 * filesystem (NTFS, APFS) answers as Linux does: our own mixed-case files
 * (`/assets/legacy/Content/…`) are served as they are, and `/Ministries/Health` is redirected
 * rather than served under a second URL.
 *
 * The Location is `rawPath` lowercased — never decoded and re-encoded — with empty segments
 * dropped and the trailing slash `pagePath` gave. The page check runs on that same string,
 * parsed again, so the Location always names exactly what was checked.
 */
async function caseRule(outputDir: string, target: RequestTarget): Promise<string | null> {
  const lowered = parseRequestTarget(target.rawPath.toLowerCase());
  if (!lowered || lowered.path === target.path) return null;
  const page = await exactPagePath(outputDir, lowered.path);
  if (page === null) return null;
  if ((await exactPagePath(outputDir, target.path)) !== null) return null;
  const segments = lowered.rawPath.split("/").filter((s) => s !== "");
  const location = `/${segments.join("/")}${page.endsWith("/") && segments.length > 0 ? "/" : ""}`;
  if (location.startsWith("//") || location.includes("\\")) return null;
  return `${location}${target.query}`;
}
