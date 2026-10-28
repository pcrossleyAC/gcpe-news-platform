import type { PostDto, ResourceLinkDto } from "../dto";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { themeDefaults } from "../settings";
import { kindFeedUrl, pageUrl, type ListingKind } from "../site-paths";
import { connectStrip } from "./connect-strip";
import { latestCards } from "./post-card";
import { resourcesBox } from "./resources";

/**
 * A per-kind listing (`/releases/`, `/stories/`, `/factsheets/`, `/updates/`; legacy's kind index):
 * the home page's news column without its carousel, top and feature slots. One h1, the title from
 * the navigation settings; the newest posts as cards (the first few shown, the rest behind Load
 * More, as on home); the Connect strip and Resources in a labelled section after the news, as on
 * home (no <aside> inside <main>). `posts` is newest first (the builder's kindPosts).
 */
export function renderKindListing(kind: ListingKind, title: string, posts: PostDto[], links: ResourceLinkDto[], site: SiteInfo, opts: PageOptions = {}): string {
  const base = basePath(site);
  const settings = opts.settings ?? themeDefaults(site.theme);
  const labels = settings.navigation.labels;
  const { cards, loadMore } = latestCards(site, posts, { loadMoreLabel: `Load More ${title}` });
  const empty = posts.length === 0 ? `<p class="listing-empty">Nothing has been published yet.</p>\n` : "";
  const resources = resourcesBox(site, labels.resources, links);
  const body = `<div class="home-layout">
<div class="home-body" id="main-content-release">
<h1 class="listing-title">${e(title)}</h1>
<div class="other-articles">
<div id="regular-articles" class="regular-articles">
${cards}
</div>
${empty}<div class="news-control">
${loadMore}<a href="${e(base)}/search/?type=${e(kind)}" class="read-more">${e(labels.searchNews)}</a>
<div class="clear"></div>
</div>
</div>
</div>
<section class="home-features" aria-label="Connect and resources">
${connectStrip(settings, base)}
${resources ? `<div class="collapsible-regions">\n${resources}\n</div>\n` : ""}</section>
</div>`;
  return renderPage(title, site, pageUrl(site, { type: "kind", kind }), body, { ...opts, feed: { href: kindFeedUrl(site, kind, "rss"), title: `${site.name}: ${kind}` } });
}
