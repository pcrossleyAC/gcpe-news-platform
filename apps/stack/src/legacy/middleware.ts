import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { DEFAULT_OG_IMAGE } from "../../../public-site/src/render";
import { feedRule, fixedRule, type FeedAction } from "./rules";
import { parseRequestTarget, type RequestTarget } from "./safe-path";
import { siteNotFound } from "../site-not-found";
import { exactPagePath, pagePath, resolvePostKey } from "./site-files";
import { resolveCategory } from "./ministry-renames";
import { categoryFiles, isCategoryKind, POST_KEY, postDir, SHORT_POST_KEY_MAX, type CategoryKind } from "../../../public-site/src/site-paths";

/**
 * What `legacyUrls` leaves in `res.locals.legacyRewrite` when it rewrites `req.url` for the
 * static mount: `from` is `req.url` as it was, `kind` what the new one names. "file": a feed or
 * the legacy OG image, served in place under any URL. "long": a long key's hashed page
 * (`/releases/_long/<hash>/`), which the static mount serves only for this rewrite (a direct
 * request for it is the site 404). "page": a listed post whose page is gone, handed to static to 404.
 */
export interface LegacyRewrite {
  from: string;
  kind: "file" | "long" | "page";
}

/** The rewrite `legacyUrls` made for this request, if any. */
export function legacyRewriteOf(res: Response): LegacyRewrite | undefined {
  return res.locals.legacyRewrite as LegacyRewrite | undefined;
}

function rewrite(req: Request, res: Response, url: string, kind: LegacyRewrite["kind"]): void {
  res.locals.legacyRewrite = { from: req.url, kind } satisfies LegacyRewrite;
  req.url = url;
}

export interface LegacyUrlOptions {
  outputDir: string;
  /** The prefix this handler is mounted under: "" at the root, "/site" under /site. */
  basePath: string;
  /** Path prefixes the site leaves alone (`SITE_PASS_THROUGH` in stack.ts), passed through before any filesystem call. */
  passThrough: readonly string[];
  /** NEWS-n reference → published post key, or null (News API's postKeyByReference). Absent: the reference rule is off. */
  lookupReference?: (reference: string) => Promise<string | null>;
}

/**
 * Old news.gov.bc.ca URLs (parity plan 3, url-compat §T1). Mounted by `mountSite` first in
 * each site chain, ahead of `express.static` (and, on an origin site, of the `/site` alias
 * redirect). Per request it:
 * - answers a no-store 301 whose Location is `${basePath}<path>` (root-relative, so the
 *   X-Forwarded-Host behind nginx or IIS/ARR never matters) and names a page that exists now; or
 * - rewrites `req.url` so the static mount serves a file in place (a feed, the legacy OG image,
 *   a long key's hashed page), noting it in `res.locals.legacyRewrite` (`LegacyRewrite`); or
 * - falls through (`next()`) to the static mount and the site 404.
 *
 * Order: method (GET/HEAD), then `parseRequestTarget` (anything unsafe is the site's 404, never
 * handed to the static mount, unless it is under a pass-through prefix), then
 * `passThrough` on the decoded path — all pure, so a pass-through prefix never costs a
 * filesystem call. Then, first match wins:
 * 1. a `fixedRule` that serves a file in place (the legacy OG image);
 * 2. the feed rule (T6, `feedRule`): `/feed`, `/<kind>/feed`, `/<cat>/<key>/feed…` and the like,
 *    served in place with the RSS / Atom type, before the post and category rules (`/releases/feed`
 *    is not the post "feed");
 * 3. a `fixedRule` redirect that is not a fallback;
 * 4. the post rule: `/(releases|stories|factsheets|updates)/<key>[/image][/]`, any case
 *    (`postRule`);
 * 5. the category rule (T4/L4, `categoryRule`): `/(ministries|sectors|themes|tags|news-subscribe)/<key>…`
 *    and `/office-of-the-premier…`, through `resolveCategory` (renames, nested keys, successors),
 *    which runs only on a parsed target;
 * 6. the reference rule (T5): a bare `/<n>` is news.gov's short link to `NEWS-<n>`; 301 to
 *    the post's page when the lookup finds a published post whose page exists. It sits before
 *    the case rule and the fallbacks, and no other rule claims a bare `/<digits>` (a fixed rule
 *    or category needs a word, the post rule a kind prefix). One DB lookup per request, served
 *    by `posts_reference_lower_idx` (`mountSite` caches misses for a minute, `cacheMisses`); a
 *    throwing lookup is logged once per message until a lookup
 *    succeeds again, then next();
 * 7. the case rule: a path with uppercase that is not a page in exactly that case, whose
 *    lowercase is one (`caseRule`) — before the fallback rules, so `/Releases` reaches a built
 *    `/releases/` in one hop, also on case-sensitive Linux;
 * 8. a *fallback* `fixedRule`, which fires only when the request path is not itself a page on
 *    disk, so a page the site later builds (plan 4's /releases/ …) wins with no change here.
 * Filesystem errors go to `next(err)`.
 */
export function legacyUrls(opts: LegacyUrlOptions): RequestHandler {
  const { outputDir, basePath } = opts;
  // Express matches mount paths case-insensitively (/API/x reaches /api), so this does too.
  const prefixes = opts.passThrough.map((p) => p.toLowerCase());
  const notFound = siteNotFound(outputDir);
  const lookupFailures = new Set<string>();
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const target = parseRequestTarget(req.url);
    if (!target) {
      // Unsafe (a decoded backslash, "/", NUL or control character in a segment, "." / "..",
      // malformed encoding, "//"). Never hand it to the static mount: on Windows a decoded
      // backslash is a path separator, so express.static would walk /Ministries/Health%5C..%5C..
      // to a directory and 301 it. A stack-owned prefix (matched on the raw path, as Express
      // mounts do) still goes to its own app; everything else is the site's 404, on every platform.
      const raw = req.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").split("?")[0]!.toLowerCase();
      if (prefixes.some((p) => raw === p || raw.startsWith(`${p}/`))) return next();
      return notFound(req, res, next);
    }
    // On the decoded path, the same one the rules match (/%75pdates/x is /updates/x to them).
    const lower = target.path.toLowerCase();
    if (prefixes.some((p) => lower === p || lower.startsWith(`${p}/`))) return next();
    // The hashed directory of long post keys has no URL of its own (any case): only the long-key
    // rule below reaches it, by rewrite. Before the case rule, which would 301 /Releases/_LONG/… to it.
    if (/^\/releases\/_long(?:\/|$)/.test(lower)) return notFound(req, res, next);
    const action = fixedRule(target.path, target.query);
    const feed = feedRule(target.path);
    const post = POST_PATH.exec(target.path);
    // Nothing can match a lowercase path but a fixed rule: no filesystem call for it.
    const category = categoryPath(target.path);
    const reference = opts.lookupReference ? REFERENCE_PATH.exec(target.path) : null;
    if (!action && !feed && !post && !category && !reference && !/[A-Z]/.test(target.path)) return next();

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
        rewrite(req, res, `/${action.file}${target.query}`, "file");
        return next();
      }

      // Feeds first: before the post rule (/releases/feed is not the post "feed") and the category rule.
      if (feed) return serveFeed(feed, req, next, res);

      if (action && !action.fallback) return fixedRedirect(action, target, res, next);

      if (post) {
        const key = post[1]!;
        if (key.length > SHORT_POST_KEY_MAX && POST_KEY.test(key)) {
          const long = await longPostRule(key, post[2] !== undefined, target);
          if (long === null) return next();
          if (long === "serve") {
            // In place: the only rewrite ever produced is /releases/_long/<32 hex>/.
            rewrite(req, res, `/${postDir(key)}/${target.query}`, "long");
            return next();
          }
          return redirect(long.status, long.to);
        }
        const done = await postRule(post, target);
        if (done === null) return next();
        if (done.status === 404) {
          // Listed but not a page (a directory a delete left empty): hand static the slash
          // form, which it 404s, so no platform answers a trailing-slash 301 to a 404 first.
          rewrite(req, res, `${done.to}${target.query}`, "page");
          return next();
        }
        return redirect(done.status, done.to);
      }

      if (category) {
        const handled = await categoryRule(category, target, res, next);
        if (handled) return;
      }

      if (reference && !action) {
        const to = await referenceRule(Number(reference[1]));
        if (to !== null) return redirect(301, `${to}${target.query}`);
        return next();
      }

      const lower = await caseRule(outputDir, target);
      if (lower !== null) return redirect(301, lower);

      if (action && (await pagePath(outputDir, target.path)) === null) return fixedRedirect(action, target, res, next);
      return next();
    })().catch(next);
  };

  /**
   * The reference rule (url-compat T5): `/<n>` → the Location (without basePath, query not
   * included) of `NEWS-<n>`'s page, or null (no such published post, a key that is not a
   * `POST_KEY`, no page on disk, or the lookup threw). The page is found through `postDir` /
   * `pagePath`, so a long key's hashed directory counts. `n` is a number, so "007" asks for NEWS-7.
   */
  async function referenceRule(n: number): Promise<string | null> {
    let key: string | null;
    try {
      key = await opts.lookupReference!(`NEWS-${n}`);
      // A success ends the outage: the next failure (a second outage, even the same message) logs again.
      lookupFailures.clear();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!lookupFailures.has(message)) {
        lookupFailures.add(message);
        console.error(`[stack] reference lookup failed: ${message}`);
      }
      return null;
    }
    if (key === null || !POST_KEY.test(key)) return null;
    const page = key.length > SHORT_POST_KEY_MAX ? `/${postDir(key)}/` : `/releases/${key}/`;
    if ((await pagePath(outputDir, page)) === null) return null;
    return `/releases/${key}/`;
  }

  /**
   * A legacy feed URL, served in place: rewrite `req.url` to the feed file and let static send it
   * (its `setHeaders` sets the RSS / Atom content type; ETag, caching and HEAD behave as for any file).
   * A category's key goes through `resolveCategory`, so a renamed or replaced ministry gets the
   * current key's file. No file: `next()` (the site 404) — and for a direct request for a moved key's
   * feed.xml / atom.xml the 404 is answered here, because static would serve the stale file.
   */
  async function serveFeed(feed: FeedAction, req: Request, next: NextFunction, res: Response): Promise<void> {
    let file: string;
    let moved = false;
    if (feed.kind === "file") file = feed.file;
    else {
      const resolved = await resolveCategory(outputDir, feed.cat, feed.segments);
      // No such category: a direct request for its feed.xml / atom.xml must not reach static, which
      // would serve an orphaned stale file (a removed category's feed not yet cleaned up).
      if (resolved === null) return feed.direct ? notFound(req, res, next) : next();
      moved = resolved.moved;
      const files = categoryFiles({ kind: feed.cat, key: resolved.key });
      file = feed.fmt === "atom" ? files.atom : files.feed;
    }
    let isFile = false;
    try {
      isFile = (await stat(join(outputDir, ...file.split("/")))).isFile();
    } catch {
      // Missing or unreadable: the site 404.
    }
    if (!isFile) return feed.kind === "category" && feed.direct && moved ? notFound(req, res, next) : next();
    rewrite(req, res, `/${file}`, "file");
    return next();
  }

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
    // The request already is the target (same path, and the query is kept or empty): static serves it.
    if (to === null || (to === target.path && (action.query === "keep" || target.query === ""))) return next();
    const absolute = action.absolute === true;
    const location = `${absolute ? "" : basePath}${to}${action.query === "keep" ? target.query : ""}`;
    // Root-relative, or the rule's own absolute https URL; never protocol-relative.
    if (absolute ? !location.startsWith("https://") : (!location.startsWith("/") || location.startsWith("//") || location.startsWith("/\\"))) return next();
    res.setHeader("Cache-Control", "no-store");
    res.redirect(action.status ?? 301, location);
  }

  /**
   * The category rule (url-compat T4, L4). Resolves the category key (renames, nested, successor),
   * then maps the rest of the path (see `categoryTargets`). Returns true when it answered
   * (a redirect, or `next()` because the request already is the target), false to let the
   * remaining rules run (no such category page; feeds and embeds, which are not this task's).
   */
  async function categoryRule(c: CategoryPath, target: RequestTarget, res: Response, next: () => void): Promise<boolean> {
    const resolved = await resolveCategory(outputDir, c.cat, c.segments.slice(0, 2));
    if (resolved === null) return false;
    const rest = c.segments.slice(resolved.consumed).map((s) => s.toLowerCase());
    const mapped = categoryTargets(c.cat, resolved.key, rest, resolved.moved);
    if (mapped === null) return false;
    await fixedRedirect({ do: "redirect", to: mapped.to, query: mapped.drop ? "drop" : "keep" }, target, res, next);
    return true;
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

  /**
   * The post rule for a key over 100 characters that matches `POST_KEY` (url-compat T3): its page
   * is `postDir(key)`, found by hash, not by a listing. The canonical request `/releases/<key>/`
   * (any case) → "serve" (the caller rewrites to the hashed dir); `/image` → 302 to the default OG
   * image; any other spelling → 301 to `/releases/<key as requested>/`, query kept. No such page →
   * null (the site 404). `key` is `[A-Za-z0-9-]{101,200}`, so the Location is safe to build.
   */
  async function longPostRule(key: string, image: boolean, target: RequestTarget): Promise<"serve" | { status: 301 | 302; to: string } | null> {
    if ((await pagePath(outputDir, `/${postDir(key)}/`)) === null) return null;
    if (image) return (await pagePath(outputDir, DEFAULT_OG_IMAGE)) === null ? null : { status: 302, to: DEFAULT_OG_IMAGE };
    if (target.path.toLowerCase() === `/releases/${key.toLowerCase()}/`) return "serve";
    return { status: 301, to: `/releases/${key}/${target.query}` };
  }
}

interface CategoryPath {
  cat: CategoryKind;
  /** The segments after the category word (original case), none empty. */
  segments: string[];
}

const KINDS = new Set(["releases", "stories", "factsheets", "updates"]);
/** `feed`, `feed.xml`, `feed.atom`…, `atom.xml`: a feed segment (served by `feedRule`), not a page. */
const isFeed = (segment: string) => /^(?:feed(?:\.[a-z]+)?|atom\.xml)$/.test(segment);
const ARCHIVE_WORDS = new Set(["more-news", "morearticles", "archive"]);

/**
 * `/(ministries|sectors|themes|tags|news-subscribe)/<key>[/…]` or `/office-of-the-premier[/…]`
 * (read as `/ministries/office-of-the-premier[/…]`), any case, one optional trailing slash and
 * no empty segment; else null. `news-subscribe` is `tags`.
 */
function categoryPath(path: string): CategoryPath | null {
  const parts = path.slice(1).split("/");
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.some((p) => p === "")) return null;
  const head = parts[0]!.toLowerCase();
  if (head === "office-of-the-premier") return { cat: "ministries", segments: parts };
  const cat = head === "news-subscribe" ? "tags" : head;
  if (!isCategoryKind(cat) || parts.length < 2) return null;
  return { cat, segments: parts.slice(1) };
}

/**
 * Where `rest` (the lowercased segments after the consumed key) goes: candidate targets in
 * `fixedRedirect`'s form (the first that is a page, or the "!" one) and whether the query is
 * dropped; null for feeds and embeds, which this rule leaves alone (`feedRule` serves feeds; embed pages do not exist, so they fall through to the site 404). `top` and `feature` are not feeds below a category: they redirect to its page.
 * `moved`: the request named another key's page, so its biography is not this key's.
 */
function categoryTargets(cat: CategoryKind, key: string, rest: string[], moved: boolean): { to: string[]; drop: boolean } | null {
  const home = `/${cat}/${key}/`;
  const [first, second] = rest;
  if (first === undefined) return { to: [`${home}!`], drop: false };
  if (isFeed(first) || first === "embed" || (KINDS.has(first) && second !== undefined && (isFeed(second) || second === "embed"))) return null;
  if (ARCHIVE_WORDS.has(first) || (KINDS.has(first) && second !== undefined && ARCHIVE_WORDS.has(second))) return { to: [`${home}!`], drop: true };
  if (first === "biography" && rest.length === 1 && cat === "ministries") return { to: moved ? [`${home}!`] : [`${home}biography/`, `${home}!`], drop: false };
  if (KINDS.has(first) && rest.length === 1) return { to: [`${home}${first}/`, `${home}!`], drop: false };
  return { to: [`/${cat}/${key}/${rest.join("/")}`, `${home}!`], drop: false };
}

type RedirectAction = Extract<NonNullable<ReturnType<typeof fixedRule>>, { do: "redirect" }>;

/** news.gov's short link: `/<n>` (1 to 9 digits), one optional trailing slash. */
const REFERENCE_PATH = /^\/(\d{1,9})\/?$/;

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
