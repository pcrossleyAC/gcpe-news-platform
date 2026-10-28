import type { CategoryDto, MinisterDto, MinistryDto, MinistryProfileDto, PostDto, ResourceLinkDto } from "../dto";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { commContact, contactValue } from "./comm-contact";
import { categoryPageId, factsheetsUrl, feedUrl, pageUrl, parsePageId, type CategoryKind } from "../site-paths";
import { sortNewest } from "./format";
import type { MinistryPageLabels } from "@gcpe/site-settings";
import { themeDefaults } from "../settings";
import { ministryLinkGroups, resourceLinks } from "./side-links";
import { ministerCard, ministrySidebar, PREMIER_KEY } from "./minister";
import { connectStrip } from "./connect-strip";
import { latestCards, postCard } from "./post-card";
import { resourcesBox } from "./resources";

interface CategoryPosts {
  top: PostDto | null;
  feature: PostDto | null;
  latest: PostDto[];
}

/** Legacy (Views/Shared/Ministry.cshtml) "Media Contacts": only when the first contact exists; the
 * second is preceded by "Alternate:", and the after-hours number comes last. */
function mediaContacts(heading: string, m: Pick<MinistryDto, "contactUser" | "secondContactUser" | "weekendContactNumber">): string {
  const first = commContact(m.contactUser);
  if (!first) return "";
  const second = commContact(m.secondContactUser);
  const afterHours = contactValue(m.weekendContactNumber);
  const parts = [first, second ? `<br>\n<span>Alternate:</span>\n${second}` : "", afterHours !== undefined ? `<br>\n<div>After hours: ${e(afterHours)}</div>` : ""].filter(Boolean);
  return `<div class="resource-links">\n<h2>${e(heading)}</h2>\n<div>\n${parts.join("\n")}\n</div>\n</div>`;
}

/** What a ministry page shows beyond the ministry and its posts: the `/api/v2/ministries` profile
 * (minister email, team links; null from an older News API) and the ministries of state under it. */
export interface MinistryPageContext {
  profile: MinistryProfileDto | null;
  children: { ministry: MinistryDto; minister: MinisterDto | null; profile: MinistryProfileDto | null }[];
}


/**
 * Legacy Ministry.cshtml's `div.collapsible-regions`, in its order: Media Contacts, Meet the Team
 * (legacy hard-coded the Premier's three links in MoreFromThis; ours are the profile's team links,
 * for any ministry that has them), More from this Ministry ("More from the Premier" for the
 * Premier), Featured Topics, Featured Services, then one minister-of-state card per child ministry.
 * Empty groups are left out.
 */
function collapsibleRegions(site: Pick<SiteInfo, "baseUrl">, m: MinistryDto, labels: MinistryPageLabels, ctx: MinistryPageContext): string {
  const [more, topics, services] = ministryLinkGroups(site, m, labels);
  const moreHeading = m.key.toLowerCase() === PREMIER_KEY ? "More from the Premier" : more!.heading;
  const boxes = [
    mediaContacts(labels.mediaContacts, m),
    resourceLinks(site, "Meet the Team", (ctx.profile?.teamLinks ?? []).map((l) => ({ text: l.text, url: l.url }))),
    resourceLinks(site, moreHeading, more!.links),
    resourceLinks(site, topics!.heading, topics!.links),
    resourceLinks(site, services!.heading, services!.links),
    ...ctx.children.map((c) => ministerCard(site, c.ministry, c.minister, c.profile, { ministryHeading: true })),
  ].filter(Boolean);
  return boxes.length ? `<div class="collapsible-regions">\n${boxes.join("\n")}\n</div>` : "";
}

export function renderMinistriesPage(ministries: MinistryDto[], site: SiteInfo, opts: PageOptions = {}): string {
  const items = ministries
    .filter((m) => m.isActive)
    .map((m) => {
      const pageId = categoryPageId("ministries", m.key);
      if (!pageId) return "";
      const parsed = parsePageId(pageId);
      if (!parsed) return "";
      const minister = m.ministerName ? ` — ${e(m.ministerName)}` : "";
      return `<li><a href="${e(pageUrl(site, parsed))}">${e(m.name)}</a>${minister}</li>`;
    })
    .filter(Boolean)
    .join("\n");
  const body = `<h1>Ministries</h1>\n<ul class="post-list">\n${items}\n</ul>`;
  return renderPage("Ministries", site, pageUrl(site, { type: "ministries" }), body, opts);
}

/**
 * Legacy Ministry.cshtml with the plan-2 accessibility deviations: the ministry name is the page's
 * one h1 (legacy's h2.ministry-name-mobile, shown only on a phone; visually hidden on wider screens),
 * the column a labelled section (not an <aside> inside <main>), and its headings one level up. The
 * collapsible regions sit in the column after the minister card, as on the home page: legacy hid
 * them on a desktop and cloned them into the column with JavaScript; ours render once. The column
 * follows the news in the DOM (below it on a phone, in reading order); CSS order puts it on the
 * left on a desktop. "Load More News" reveals the cards already on
 * the page (site.js).
 */
export function renderMinistryPage(m: MinistryDto, minister: MinisterDto | null, posts: CategoryPosts, site: SiteInfo, opts: PageOptions, ctx: MinistryPageContext): string {
  const key = m.key.toLowerCase();
  const base = basePath(site);
  const settings = opts.settings ?? themeDefaults(site.theme);
  const top = posts.top ? `<div class="top-article">\n${postCard(site, posts.top, { eager: true })}\n</div>\n` : "";
  const feature = posts.feature ? `<div class="feature-article">\n${postCard(site, posts.feature)}\n</div>\n` : "";
  const { cards, loadMore } = latestCards(site, posts.latest, { loadMoreLabel: settings.navigation.labels.loadMoreNews });
  return ministryListing(m, minister, site, opts, ctx, {
    title: m.name,
    url: pageUrl(site, { type: "category", kind: "ministries", key }),
    listingClass: "",
    intro: top + feature,
    cards,
    loadMore,
    empty: "",
    searchHref: `${base}/search/?ministry=${encodeURIComponent(key)}`,
  });
}

/**
 * A ministry's factsheets page (legacy `/ministries/<key>/factsheets`, H5): the ministry page's
 * skeleton and side column, with a "Factsheets" heading under the ministry name, no top or feature
 * article, the ministry's factsheets as cards (newest first; the builder's merge), Load More, and
 * Search News filtered to factsheets of this ministry. Its feed is the ministry's feed (legacy's).
 */
export function renderMinistryFactsheetsPage(m: MinistryDto, minister: MinisterDto | null, posts: PostDto[], site: SiteInfo, opts: PageOptions, ctx: MinistryPageContext): string {
  const key = m.key.toLowerCase();
  const base = basePath(site);
  const { cards, loadMore } = latestCards(site, posts, { loadMoreLabel: "Load More" });
  return ministryListing(m, minister, site, opts, ctx, {
    title: `Factsheets: ${m.name}`,
    url: factsheetsUrl(site, key),
    listingClass: " fact-sheets",
    intro: `<h2 class="listing-title">Factsheets</h2>\n`,
    cards,
    loadMore,
    empty: posts.length === 0 ? `<p class="listing-empty">Nothing has been published yet.</p>\n` : "",
    searchHref: `${base}/search/?type=factsheets&ministry=${encodeURIComponent(key)}`,
  });
}

/** The skeleton both ministry pages share: the ministry name as the one h1, the news column, then the side column. */
function ministryListing(
  m: MinistryDto,
  minister: MinisterDto | null,
  site: SiteInfo,
  opts: PageOptions,
  ctx: MinistryPageContext,
  v: { title: string; url: string; listingClass: string; intro: string; cards: string; loadMore: string; empty: string; searchHref: string },
): string {
  const key = m.key.toLowerCase();
  const base = basePath(site);
  const settings = opts.settings ?? themeDefaults(site.theme);
  const body = `<h1 class="ministry-name-mobile">${e(m.name)}</h1>
<div class="pt-2 ministry-listing${v.listingClass}">
<div class="home-layout">
<div class="home-body" id="main-content-release">
${v.intro}<div class="other-articles">
<div id="regular-articles" class="regular-articles">
${v.cards}
</div>
${v.empty}<div class="news-control">
${v.loadMore}<a href="${e(v.searchHref)}" class="read-more">${e(settings.navigation.labels.searchNews)}</a>
<div class="clear"></div>
</div>
<p><a href="${e(base)}/archive/">Browse the archive by month</a></p>
</div>
</div>
${ministrySidebar(site, m, minister, ctx.profile, collapsibleRegions(site, m, settings.ministryPages, ctx))}
</div>
</div>`;

  return renderPage(v.title, site, v.url, body, {
    ...opts,
    feed: { href: feedUrl(site, { type: "category", kind: "ministries", key }), title: `${site.name}: ${m.name}` },
  });
}

/**
 * A sector, theme or tag page in legacy Sector.cshtml's look: the ministry listing's skeleton
 * (`.ministry-listing.sector-listing > .home-layout`) with no side column. The category name is the
 * one h1; the cards are the top, feature and latest posts in one newest-first list, each once
 * (spec conflict 11: legacy's Sector.cshtml left the top and feature out); Load More only past
 * three; Search News only where `/api/v2/search` can filter (sectors); then the archive link and the
 * Resources box. The Connect strip follows in a labelled section (no <aside> inside <main>).
 */
export function renderCategoryPage(kind: Exclude<CategoryKind, "ministries">, c: CategoryDto, posts: CategoryPosts, links: ResourceLinkDto[], site: SiteInfo, opts: PageOptions = {}): string {
  const key = c.key.toLowerCase();
  const base = basePath(site);
  const settings = opts.settings ?? themeDefaults(site.theme);
  const labels = settings.navigation.labels;
  const merged = sortNewest([posts.top, posts.feature, ...posts.latest]);
  const { cards, loadMore } = latestCards(site, merged, { loadMoreLabel: labels.loadMoreNews });
  const empty = merged.length === 0 ? `<p class="listing-empty">Nothing has been published yet.</p>\n` : "";
  const search = kind === "sectors" ? `<a href="${e(base)}/search/?sector=${e(encodeURIComponent(key))}" class="read-more">${e(labels.searchNews)}</a>\n` : "";
  const resources = resourcesBox(site, labels.resources, links);
  const body = `<h1 class="ministry-name-mobile">${e(c.name)}</h1>
<div class="pt-2 ministry-listing sector-listing">
<div class="home-layout">
<div class="home-body" id="main-content-release">
<div class="other-articles">
<div id="regular-articles" class="regular-articles">
${cards}
</div>
${empty}<div class="news-control">
${loadMore}${search}<div class="clear"></div>
</div>
<p><a href="${e(base)}/archive/">Browse the archive by month</a></p>
</div>
<div class="collapsible-regions">${resources ? `\n${resources}` : ""}
</div>
</div>
<section class="home-features" aria-label="${e(`About ${c.name}`)}">
<p class="ministry-title" aria-hidden="true">${e(c.name)}</p>
${connectStrip(settings, base)}
</section>
</div>
</div>`;

  return renderPage(c.name, site, pageUrl(site, { type: "category", kind, key }), body, {
    ...opts,
    feed: { href: feedUrl(site, { type: "category", kind, key }), title: `${site.name}: ${c.name}` },
  });
}
