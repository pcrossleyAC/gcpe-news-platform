import { e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { sitemapHtmlUrl } from "../site-paths";

/** One heading of the HTML sitemap and its links (`path` is the in-site link, base path included). */
export type SitemapGroup = { heading: string; entries: { name: string; path: string }[] };

/**
 * `/sitemap/` (L2): the same entries as `sitemaps/pages.xml`, for people. One h1, then an h2 and a
 * list per group; a group with no entries is left out. Names are escaped; paths come from pageUrl
 * and the other site-path helpers (so they carry the base path) and are escaped as attributes.
 */
export function renderHtmlSitemap(groups: SitemapGroup[], site: SiteInfo, opts: PageOptions = {}): string {
  const sections = groups
    .filter((g) => g.entries.length > 0)
    .map((g) => `<h2>${e(g.heading)}</h2>\n<ul>\n${g.entries.map((x) => `<li><a href="${e(x.path)}">${e(x.name)}</a></li>`).join("\n")}\n</ul>`)
    .join("\n");
  const body = `<div class="home-body archive-page" id="main-content-release">\n<h1>Site map</h1>\n${sections}\n</div>`;
  return renderPage("Site map", site, sitemapHtmlUrl(site), body, opts);
}
