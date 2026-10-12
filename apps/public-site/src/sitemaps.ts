import { ex, type SiteInfo } from "./render";
import { absoluteUrl } from "./site-paths";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

/** A sitemap index: one `<sitemap>` per per-month (or pages) sitemap (spec §6.1). */
export function renderSitemapIndex(sitemapPaths: string[], site: SiteInfo): string {
  const entries = sitemapPaths.map((p) => `<sitemap><loc>${ex(absoluteUrl(site, p))}</loc></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<sitemapindex xmlns="${NS}">\n${entries}\n</sitemapindex>\n`;
}

/** A urlset of absolute `<loc>`s, with a date-only W3C `<lastmod>` when a well-formed one is
 * given. `ex()` escapes `&`/`<`/`>`/quotes and strips XML-illegal control characters from the
 * `loc`, so an ill-formed path can never produce ill-formed XML. */
export function renderUrlSet(entries: { path: string; lastmod?: string }[], site: SiteInfo): string {
  const urls = entries
    .map((u) => `<url><loc>${ex(absoluteUrl(site, u.path))}</loc>${u.lastmod && /^\d{4}-\d{2}-\d{2}/.test(u.lastmod) ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="${NS}">\n${urls}\n</urlset>\n`;
}
