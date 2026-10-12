import { basePath, type SiteInfo } from "./render";

/** A post key as NRMS and the News API produce it. Also the on-disk directory name. */
export const POST_KEY = /^[A-Za-z0-9-]{1,100}$/;
/** A category key (ministry, sector, theme, tag) in its lowercased on-disk form. */
export const CATEGORY_KEY = /^[a-z0-9-]{1,100}$/;
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
  | { type: "sitemap" }
  | { type: "sitemap-month"; month: string }
  | { type: "sitemap-pages" }
  | { type: "static" };

const SINGLE: Record<string, PageId> = {
  home: { type: "home" },
  ministries: { type: "ministries" },
  archive: { type: "archive" },
  sitemap: { type: "sitemap" },
  "sitemap:pages": { type: "sitemap-pages" },
  static: { type: "static" },
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
  return null;
}

export function formatPageId(p: PageId): string {
  switch (p.type) {
    case "post": return `post:${p.key}`;
    case "category": return `category:${p.kind}:${p.key}`;
    case "archive-month": return `archive:${p.month}`;
    case "sitemap-month": return `sitemap:${p.month}`;
    case "sitemap-pages": return "sitemap:pages";
    default: return p.type;
  }
}

/** The page id for a category key as the News API spells it; null when the key isn't safe. */
export function categoryPageId(kind: CategoryKind, key: string): string | null {
  const lower = key.toLowerCase();
  return CATEGORY_KEY.test(lower) ? `category:${kind}:${lower}` : null;
}

export const postPath = (key: string) => `releases/${key}/index.html`;

/** Relative output files for a page. Only ever called with a parsed (validated) PageId. */
export function pageFiles(p: PageId): string[] {
  switch (p.type) {
    case "home": return ["index.html", "feed.xml"];
    case "post": return [postPath(p.key)];
    case "ministries": return ["ministries/index.html"];
    case "category": return [`${p.kind}/${p.key}/index.html`, `${p.kind}/${p.key}/feed.xml`];
    case "archive": return ["archive/index.html"];
    case "archive-month": return [`archive/${p.month.slice(0, 4)}/${p.month.slice(5)}/index.html`];
    case "sitemap": return ["sitemap.xml"];
    case "sitemap-month": return [`sitemaps/${p.month}.xml`];
    case "sitemap-pages": return ["sitemaps/pages.xml"];
    case "static": return ["assets/theme.css", "404.html", "robots.txt"];
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
    case "sitemap": return `${base}/sitemap.xml`;
    case "sitemap-month": return `${base}/sitemaps/${p.month}.xml`;
    case "sitemap-pages": return `${base}/sitemaps/pages.xml`;
    case "static": return `${base}/404.html`;
  }
}

export function feedUrl(site: Pick<SiteInfo, "baseUrl">, p: { type: "home" } | { type: "category"; kind: CategoryKind; key: string }): string {
  return p.type === "home" ? `${basePath(site)}/feed.xml` : `${basePath(site)}/${p.kind}/${p.key}/feed.xml`;
}

export const absoluteUrl = (site: Pick<SiteInfo, "baseUrl">, path: string) => new URL(site.baseUrl).origin + path;
