import { GOVERNMENT_TERM_SLUG } from "@gcpe/config";
import { basePath, type SiteInfo } from "./render";

/** A post key as NRMS and the News API produce it. Also the on-disk directory name. */
export const POST_KEY = /^[A-Za-z0-9-]{1,100}$/;
/** A category key (ministry, sector, theme, tag) in its lowercased on-disk form. */
export const CATEGORY_KEY = /^[a-z0-9-]{1,100}$/;
/** A government term slug (an imported legacy name or a new term's ISO start date); `current` is the
 * alias. The one definition is the tenant config's (F8). */
export const TERM_SLUG = GOVERNMENT_TERM_SLUG;
/** A BC calendar month. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const CATEGORY_KINDS = ["ministries", "sectors", "themes", "tags"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const isCategoryKind = (s: string): s is CategoryKind => (CATEGORY_KINDS as readonly string[]).includes(s);

export type PageId =
  | { type: "home" }
  | { type: "post"; key: string }
  | { type: "ministries" }
  | { type: "category"; kind: CategoryKind; key: string }
  | { type: "archive" }
  | { type: "archive-month"; month: string }
  | { type: "search" }
  | { type: "sitemap" }
  | { type: "sitemap-month"; month: string }
  | { type: "sitemap-pages" }
  | { type: "static" }
  | { type: "connect" }
  /** The Media Contacts directory (H3). */
  | { type: "contacts" }
  | { type: "archive-terms" }
  | { type: "archive-term"; slug: string }
  /** Not a page: the successor-redirect table the stack's middleware reads (new-government §4). */
  | { type: "legacy-redirects" };

const SINGLE: Record<string, PageId> = {
  home: { type: "home" },
  ministries: { type: "ministries" },
  archive: { type: "archive" },
  search: { type: "search" },
  sitemap: { type: "sitemap" },
  "sitemap:pages": { type: "sitemap-pages" },
  static: { type: "static" },
  connect: { type: "connect" },
  contacts: { type: "contacts" },
  "archive-terms": { type: "archive-terms" },
  "legacy-redirects": { type: "legacy-redirects" },
};

/** The one gate between a page id (from an event, the change feed or the queue) and a path. */
export function parsePageId(id: string): PageId | null {
  if (Object.hasOwn(SINGLE, id)) return SINGLE[id]!;
  const parts = id.split(":");
  const [head] = parts;
  if (head === "post" && parts.length === 2 && POST_KEY.test(parts[1]!)) return { type: "post", key: parts[1]! };
  if (head === "category" && parts.length === 3 && isCategoryKind(parts[1]!) && CATEGORY_KEY.test(parts[2]!)) return { type: "category", kind: parts[1] as CategoryKind, key: parts[2]! };
  if (head === "archive" && parts.length === 2 && MONTH.test(parts[1]!)) return { type: "archive-month", month: parts[1]! };
  if (head === "sitemap" && parts.length === 2 && MONTH.test(parts[1]!)) return { type: "sitemap-month", month: parts[1]! };
  if (head === "archive-term" && parts.length === 2 && TERM_SLUG.test(parts[1]!)) return { type: "archive-term", slug: parts[1]! };
  return null;
}

export function formatPageId(p: PageId): string {
  switch (p.type) {
    case "post": return `post:${p.key}`;
    case "category": return `category:${p.kind}:${p.key}`;
    case "archive-month": return `archive:${p.month}`;
    case "sitemap-month": return `sitemap:${p.month}`;
    case "sitemap-pages": return "sitemap:pages";
    case "archive-term": return `archive-term:${p.slug}`;
    default: return p.type;
  }
}

/** The page id for a category key as the News API spells it; null when the key isn't safe. */
export function categoryPageId(kind: CategoryKind, key: string): string | null {
  const lower = key.toLowerCase();
  return CATEGORY_KEY.test(lower) ? `category:${kind}:${lower}` : null;
}

/** `{ successors: { "<old>": "<new>" } }`, read by apps/stack's ministrySuccessorRedirects. Parity
 * url-compat's per-post maps share the `legacy/` directory. */
export const MINISTRY_SUCCESSORS_FILE = "legacy/ministry-successors.json";

export const postPath = (key: string) => `releases/${key}/index.html`;

/** Relative output files for a page. Only ever called with a parsed (validated) PageId. */
export function pageFiles(p: PageId): string[] {
  switch (p.type) {
    case "home": return ["index.html", "feed.xml"];
    case "post": return [postPath(p.key)];
    case "ministries": return ["ministries/index.html"];
    // A ministry's third file is its minister's biography page (H2): written only while the
    // minister has a bio, and removed with the rest when the ministry goes.
    case "category": return [`${p.kind}/${p.key}/index.html`, `${p.kind}/${p.key}/feed.xml`, ...(p.kind === "ministries" ? [`${p.kind}/${p.key}/biography/index.html`] : [])];
    case "archive": return ["archive/index.html"];
    case "archive-month": return [`archive/${p.month.slice(0, 4)}/${p.month.slice(5)}/index.html`];
    case "search": return ["search/index.html"];
    case "sitemap": return ["sitemap.xml"];
    case "sitemap-month": return [`sitemaps/${p.month}.xml`];
    case "sitemap-pages": return ["sitemaps/pages.xml"];
    case "static": return ["assets/theme.css", "assets/site-banner.json", "404.html", "robots.txt"];
    case "connect": return ["connect/index.html"];
    case "contacts": return ["contacts/index.html"];
    case "archive-terms": return ["archive/terms/index.html"];
    case "archive-term": return [`archive/terms/${p.slug}/index.html`];
    case "legacy-redirects": return [MINISTRY_SUCCESSORS_FILE];
  }
}

/** The in-site link to a page (directory pages end in "/"). */
export function pageUrl(site: Pick<SiteInfo, "baseUrl">, p: PageId): string {
  const base = basePath(site);
  switch (p.type) {
    case "home": return `${base}/`;
    case "post": return `${base}/releases/${encodeURIComponent(p.key)}/`;
    case "ministries": return `${base}/ministries/`;
    case "category": return `${base}/${p.kind}/${p.key}/`;
    case "archive": return `${base}/archive/`;
    case "archive-month": return `${base}/archive/${p.month.slice(0, 4)}/${p.month.slice(5)}/`;
    case "search": return `${base}/search/`;
    case "sitemap": return `${base}/sitemap.xml`;
    case "sitemap-month": return `${base}/sitemaps/${p.month}.xml`;
    case "sitemap-pages": return `${base}/sitemaps/pages.xml`;
    case "static": return `${base}/404.html`;
    case "connect": return `${base}/connect/`;
    case "contacts": return `${base}/contacts/`;
    case "archive-terms": return `${base}/archive/terms/`;
    case "archive-term": return `${base}/archive/terms/${p.slug}/`;
    case "legacy-redirects": return `${base}/${MINISTRY_SUCCESSORS_FILE}`;
  }
}

export function feedUrl(site: Pick<SiteInfo, "baseUrl">, p: { type: "home" } | { type: "category"; kind: CategoryKind; key: string }): string {
  return p.type === "home" ? `${basePath(site)}/feed.xml` : `${basePath(site)}/${p.kind}/${p.key}/feed.xml`;
}

/** A ministry's minister biography page (the third file of its category page). */
export const biographyUrl = (site: Pick<SiteInfo, "baseUrl">, key: string): string => `${basePath(site)}/ministries/${encodeURIComponent(key.toLowerCase())}/biography/`;

export const absoluteUrl = (site: Pick<SiteInfo, "baseUrl">, path: string) => new URL(site.baseUrl).origin + path;
