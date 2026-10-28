/**
 * The fixed news.gov.bc.ca rule table (parity plan 3, Task 1): legacy paths whose target does
 * not depend on what is on disk beyond a candidate list. Pure — the middleware does every
 * filesystem check. Sources: legacy `RouteConfig.cs` and `Middleware/RedirectMiddlewarecs.cs`
 * (Gov.News.WebApp at 3fdf3e6), url-compat §T1, gap-audit M16/H5.
 */

import { FEED_POST_KINDS, isCategoryKind, kindFeedFile, type CategoryKind, type FeedPostKind } from "../../../public-site/src/site-paths";

export type LegacyAction =
  | {
      do: "redirect";
      /**
       * Candidate targets, root-relative (the middleware prefixes the mount's basePath) or the
       * one absolute forms.gov URL. The first one `pagePath` finds wins; a last entry ending
       * "!" is unconditional (the "!" is stripped).
       */
      to: string[];
      query: "keep" | "drop";
      status?: 301 | 302;
      /** Fire only when the request path itself is not a page on disk (`pagePath` is null). */
      fallback?: boolean;
      /**
       * The targets are absolute https URLs (forms.gov): no basePath is prefixed and the
       * Location guard checks for "https://" instead of a root-relative path.
       */
      absolute?: boolean;
    }
  | { do: "serve"; file: string; type: string };

/** The four legacy post kinds' path segment. */
const KIND = "(?:releases|stories|factsheets|updates)";

/** The vendored legacy OG image (plan 2), served in place at its two legacy URLs. */
export const LEGACY_OG_IMAGE = "assets/legacy/Content/Images/Gov/default-og-image-new.jpg";

const redirect = (to: string[], query: "keep" | "drop", fallback = false): LegacyAction =>
  fallback ? { do: "redirect", to, query, fallback: true } : { do: "redirect", to, query };

/** Table rows whose action depends only on the path, tried in order (anchored, whole segments). */
const PATH_RULES: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => LegacyAction]> = [
  [new RegExp(`^(?:/${KIND})?/more-news$|^/${KIND}/(?:morearticles|archive(?:/\\d{4})?)$`), () => redirect(["/archive/!"], "drop")],
  // Legacy's {month?} took "1" as well as "01"; the new archive's month folders are two digits.
  [new RegExp(`^/${KIND}/archive/(\\d{4})/(\\d{1,2})$`), (m) => redirect([`/archive/${m[1]}/${m[2]!.padStart(2, "0")}/`, "/archive/!"], "drop")],
  // Fallback: plan 4's year page (archive/<yyyy>/index.html), once built, wins.
  [/^\/archive\/\d{4}$/, () => redirect(["/archive/!"], "drop", true)],
  [new RegExp(`^/${KIND}$`), () => redirect(["/!"], "drop", true)],
  [/^\/news-subscribe$/, () => redirect(["/tags/", "/!"], "drop", true)],
  [/^\/(?:sectors|themes|tags)$/, () => redirect(["/!"], "drop", true)],
  [/^\/sitemap\/html$/, () => redirect(["/sitemap/", "/archive/!"], "drop")],
  [/^\/contact$/, () => ({ do: "redirect", to: ["https://forms.gov.bc.ca/!"], query: "drop", absolute: true })],
  [/^\/subscribe\/index$/, () => redirect(["/subscribe/!"], "keep")],
  [/^\/subscribe\/(?:save|renew)$|^\/enewsletters\/unsubscribe\.aspx$/, () => redirect(["/subscribe/manage/!"], "drop")],
  [/^\/newsletters\/subscribe$|^\/enewsletters\/subscribe\.aspx$/, () => redirect(["/subscribe/!"], "drop")],
  [/^\/newsletters(?:\/.*)?$/, () => redirect(["/!"], "drop")],
  [/^\/rss\/.+$/, () => redirect(["/connect/!"], "drop")],
  [/^\/content\/images\/gov\/default-og-image-new\.jpg$|^\/areas\/newsroom\/images\/social\/default-og-meta-image\.jpg$/, () => ({ do: "serve", file: LEGACY_OG_IMAGE, type: "image/jpeg" })],
];

export type FeedFormat = "rss" | "atom";

/** What a legacy feed URL asks for (url-compat T6); every one is served in place by the middleware. */
export type FeedAction =
  | { kind: "file"; file: string; fmt: FeedFormat }
  /** A category's feed: the key is resolved (renames, successors) before the file is chosen. */
  | { kind: "category"; cat: CategoryKind; segments: string[]; fmt: FeedFormat; direct: boolean };

const FEED_KINDS = new Set<string>(FEED_POST_KINDS);

/**
 * The feed a decoded request `path` asks for, or null. Compared lowercased with one trailing slash
 * stripped; whole segments; the query never matters. Pure: the middleware does every filesystem check.
 * - `/feed`, `/feed/rss`, `/rss.xml`, `/(top|feature)/<any>[/rss]` → feed.xml; `/feed/atom`,
 *   `/(top|feature)/<any>/atom` → atom.xml;
 * - `/<kind>/feed[/rss|/atom]` → `kindFeedFile`;
 * - `/<cat>/<a>[/<b>][/<kind>]/feed[/rss|/atom]` and `/office-of-the-premier[/<kind>]/feed[/…]`
 *   → the category's feed (the kind is ignored: a category has one feed);
 * - `/<cat>/<key>/feed.xml` and `atom.xml` (`direct`): the files themselves, so a key that moved
 *   (renamed, or replaced by a successor) is answered with the current key's file, not a stale one.
 */
export function feedRule(path: string): FeedAction | null {
  let p = path.toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/feed" || p === "/feed/rss" || p === "/rss.xml") return { kind: "file", file: "feed.xml", fmt: "rss" };
  if (p === "/feed/atom") return { kind: "file", file: "atom.xml", fmt: "atom" };
  const top = /^\/(?:top|feature)\/[^/]+(?:\/(rss|atom))?$/.exec(p);
  if (top) return top[1] === "atom" ? { kind: "file", file: "atom.xml", fmt: "atom" } : { kind: "file", file: "feed.xml", fmt: "rss" };

  const parts = p.slice(1).split("/");
  const head = parts[0]!;
  if (FEED_KINDS.has(head) && parts[1] === "feed" && parts.length <= 3) {
    const fmt = parts[2];
    if (fmt === undefined || fmt === "rss" || fmt === "atom") return { kind: "file", file: kindFeedFile(head as FeedPostKind, fmt === "atom" ? "atom" : "rss"), fmt: fmt === "atom" ? "atom" : "rss" };
    return null;
  }

  const premier = head === "office-of-the-premier";
  const catWord = head === "news-subscribe" ? "tags" : head;
  if (!premier && !isCategoryKind(catWord)) return null;
  const cat: CategoryKind = premier ? "ministries" : (catWord as CategoryKind);
  const rest = premier ? parts : parts.slice(1);

  if (!premier && rest.length === 2 && (rest[1] === "feed.xml" || rest[1] === "atom.xml")) {
    return { kind: "category", cat, segments: [rest[0]!], fmt: rest[1] === "atom.xml" ? "atom" : "rss", direct: true };
  }

  let fmt: FeedFormat = "rss";
  const last = rest[rest.length - 1];
  if ((last === "rss" || last === "atom") && rest[rest.length - 2] === "feed") {
    fmt = last;
    rest.pop();
  }
  if (rest[rest.length - 1] !== "feed") return null;
  rest.pop();
  if (rest.length > 0 && FEED_KINDS.has(rest[rest.length - 1]!)) rest.pop();
  if (rest.length < 1 || rest.length > (premier ? 1 : 2)) return null;
  return { kind: "category", cat, segments: rest, fmt, direct: false };
}

/** The raw `name=value` pairs of a query ("" or "?…"), split on "&", bytes untouched. */
const params = (query: string) => (query.length > 1 ? query.slice(1).split("&") : []);
/** A raw pair's name, lowercased ("" when it is not percent-decodable — such a pair never matches). */
function paramName(pair: string): string {
  const eq = pair.indexOf("=");
  try {
    return decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " ")).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The action for a decoded request `path` and its raw `query`, or null. The path is compared
 * lowercased with one trailing slash stripped; segments match whole. Rules whose target depends
 * on the query (`/subscribe`+newsletters, `/subscribe.aspx`, `resultspagenum`) are resolved here
 * and returned finished, with `query: "drop"`.
 */
export function fixedRule(path: string, query: string): LegacyAction | null {
  let p = path.toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);

  if (p === "/subscribe" && query.toLowerCase().includes("newsletters")) return redirect(["/subscribe/!"], "drop");

  if (p === "/subscribe.aspx") {
    // Legacy: "/subscribe.aspx?guid=<g>" → "/subscribe/manage?token=<g>". <g> is copied raw;
    // the Location's path is fixed, so the value can only ever land in our own query string.
    const guid = params(query).find((pair) => paramName(pair) === "guid");
    const value = guid?.slice(guid.indexOf("=") + 1) ?? "";
    if (!guid?.includes("=") || value === "") return null;
    return redirect([`/subscribe/manage/?token=${value}!`], "drop");
  }

  if (p === "/search") {
    const pairs = params(query);
    const kept = pairs.filter((pair) => paramName(pair) !== "resultspagenum");
    if (kept.length === pairs.length) return null; // express.static serves (or slash-redirects) /search
    return redirect([`/search/${kept.length > 0 ? `?${kept.join("&")}` : ""}!`], "drop");
  }

  for (const [re, action] of PATH_RULES) {
    const m = re.exec(p);
    if (m) return action(m);
  }
  return null;
}
