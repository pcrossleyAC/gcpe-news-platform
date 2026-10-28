import type { PostDto, ResourceLinkDto } from "../dto";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { themeDefaults } from "../settings";
import { pageUrl, type CategoryKind } from "../site-paths";
import { connectStrip } from "./connect-strip";
import { postCard } from "./post-card";
import { resourcesBox } from "./resources";

/** One category on an index page: its newest posts (sectors show up to three, the others one). */
export type IndexGroup = { key: string; name: string; top: PostDto | null; feature: PostDto | null; latest: PostDto[] };

/** How many latest posts a sector group shows (legacy's News by Sector). */
export const SECTOR_INDEX_LATEST = 3;

/** "News by {…}" per kind: news.gov calls tags "Topic". */
const KIND_NOUN: Record<CategoryKind, string> = { ministries: "Ministry", sectors: "Sector", themes: "Theme", tags: "Topic" };

/** The Search News filter each kind supports (`/api/v2/search`), else none. */
const SEARCH_PARAM: Partial<Record<CategoryKind, string>> = { ministries: "ministry", sectors: "sector" };

/**
 * `/ministries/`, `/sectors/`, `/themes/` and `/tags/` (legacy "News by Ministry" and its kin):
 * one group per category with its name linking to the category page, its newest posts, then Browse
 * More News (the category page) and, for ministries and sectors, Search News filtered to it. A
 * category with no posts still lists its heading and Browse More News. The page's one h1 names the
 * kind; the Connect strip and Resources box follow in a labelled section (no <aside> inside <main>).
 */
export function renderCategoryIndex(kind: CategoryKind, groups: IndexGroup[], links: ResourceLinkDto[], site: SiteInfo, opts: PageOptions = {}): string {
  const base = basePath(site);
  const settings = opts.settings ?? themeDefaults(site.theme);
  const labels = settings.navigation.labels;
  const heading = `News by ${KIND_NOUN[kind]}`;
  const searchParam = SEARCH_PARAM[kind];
  const group = (g: IndexGroup): string => {
    const href = e(pageUrl(site, { type: "category", kind, key: g.key }));
    const cards =
      kind === "sectors"
        ? g.latest.length
          ? `<div class="other-articles">\n<div class="regular-articles">\n${g.latest.slice(0, SECTOR_INDEX_LATEST).map((p) => postCard(site, p)).join("\n")}\n</div>\n</div>\n`
          : ""
        : [
            g.top ? `<div class="top-article">\n${postCard(site, g.top)}\n</div>\n` : "",
            g.feature || g.latest[0]
              ? `<div class="other-articles">\n${g.feature ? `<div class="feature-article">\n${postCard(site, g.feature)}\n</div>\n` : ""}${g.latest[0] ? `<div class="regular-articles">\n${postCard(site, g.latest[0])}\n</div>\n` : ""}</div>\n`
              : "",
          ].join("");
    const search = searchParam ? `<a href="${e(`${base}/search/?${searchParam}=${encodeURIComponent(g.key)}`)}" class="read-more">${e(labels.searchNews)}</a>\n` : "";
    return `<div class="grouped-articles">
<h2><a href="${href}">${e(g.name)}</a></h2>
${cards}<div class="news-control">
<a href="${href}" class="load-more link-button">${e(labels.browseMoreNews)}</a>
${search}<div class="clear"></div>
</div>
</div>`;
  };
  const resources = resourcesBox(site, labels.resources, links);
  const body = `<div class="news-listing">
<div class="home-layout">
<div class="home-body" id="main-content-release">
<h1>${e(heading)}</h1>
${groups.map(group).join("\n")}
</div>
<section class="home-features" aria-label="Connect and resources">
${connectStrip(settings, base)}${resources ? `\n${resources}` : ""}
</section>
</div>
</div>`;
  return renderPage(heading, site, pageUrl(site, kind === "ministries" ? { type: "ministries" } : { type: "category-index", kind }), body, opts);
}
