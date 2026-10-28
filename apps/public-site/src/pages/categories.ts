import type { CategoryDto, MinisterDto, MinistryContactDto, MinistryDto, MinistryProfileDto, PostDto } from "../dto";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { categoryPageId, feedUrl, pageUrl, parsePageId, type CategoryKind } from "../site-paths";
import { displayDate, postListItem } from "./format";
import type { MinistryPageLabels } from "@gcpe/site-settings";
import { themeDefaults } from "../settings";
import { ministryLinkGroups, resourceLinks } from "./side-links";
import { ministerCard, ministrySidebar, PREMIER_KEY } from "./minister";
import { postCard } from "./post-card";

interface CategoryPosts {
  top: PostDto | null;
  feature: PostDto | null;
  latest: PostDto[];
}

const ENGLISH = 4105;
const english = (p: PostDto) => p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];

function listCard(site: Pick<SiteInfo, "baseUrl">, p: PostDto): string {
  const headline = english(p)?.headline ?? p.key;
  const summary = p.summary ? `<p>${e(p.summary)}</p>` : "";
  return `<div class="card"><a href="${e(pageUrl(site, { type: "post", key: p.key }))}">${e(headline)}</a> <time datetime="${e(p.publishDate)}">${e(displayDate(p.publishDate))}</time>${summary}</div>`;
}

function postsSections(site: SiteInfo, posts: CategoryPosts): string {
  const top = posts.top ? `<section>\n<h2>Top story</h2>\n${listCard(site, posts.top)}\n</section>` : "";
  const feature = posts.feature ? `<section>\n<h2>Featured</h2>\n${listCard(site, posts.feature)}\n</section>` : "";
  const latest = posts.latest.length
    ? `<section>\n<h2>Latest news</h2>\n<ul class="post-list">\n${posts.latest.map((p) => postListItem(site, { key: p.key, headline: english(p)?.headline ?? p.key, publishDate: p.publishDate, summary: p.summary })).join("\n")}\n</ul>\n</section>`
    : "";
  return [top, feature, latest].filter(Boolean).join("\n");
}

const SEARCH_FILTER: Partial<Record<CategoryKind, string>> = { ministries: "ministry", sectors: "sector" };

/** "Browse the archive by month" plus, only for the kinds `/api/v2/search` can filter by
 * (ministries, sectors — §6.1; Q82), "search <name> news". */
function moreLinks(site: SiteInfo, kind: CategoryKind, key: string, name: string): string {
  const filter = SEARCH_FILTER[kind];
  const search = filter ? ` or <a href="${e(basePath(site))}/search/?${filter}=${e(encodeURIComponent(key))}">search ${e(name)} news</a>` : "";
  return `<p><a href="${e(basePath(site))}/archive/">Browse the archive by month</a>${search}.</p>`;
}

/** Only non-empty strings are ever read from a contact (it comes over the wire), each escaped. */
function contactValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** One contact, as legacy's CommContact partial renders it: name, "Direct: <phone>" and
 * "Cell: <mobile>" in a div, then the email as a mailto link. Empty when the contact has no field at all. */
function contactBlock(c: MinistryContactDto | null | undefined): string {
  if (!c || typeof c !== "object") return "";
  const name = contactValue(c.fullName);
  const phone = contactValue(c.phoneNumber);
  const mobile = contactValue(c.mobileNumber);
  const email = contactValue(c.emailAddress);
  if ([name, phone, mobile, email].every((v) => v === undefined)) return "";
  const numbers = [phone !== undefined ? `<span>Direct: ${e(phone)}</span>` : "", mobile !== undefined ? `<span>Cell: ${e(mobile)}</span>` : ""].filter(Boolean);
  return [
    name !== undefined ? `<span class="contact-name">${e(name)}</span>` : "",
    numbers.length ? `<div>${numbers.join("<br>")}</div>` : "",
    email !== undefined ? `<a href="mailto:${e(email)}">${e(email)}</a><br>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Legacy (Views/Shared/Ministry.cshtml) "Media Contacts": only when the first contact exists; the
 * second is preceded by "Alternate:", and the after-hours number comes last. */
function mediaContacts(heading: string, m: Pick<MinistryDto, "contactUser" | "secondContactUser" | "weekendContactNumber">): string {
  const first = contactBlock(m.contactUser);
  if (!first) return "";
  const second = contactBlock(m.secondContactUser);
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

/** Legacy shows the first three latest posts; the rest wait behind "Load More News". */
const VISIBLE_LATEST = 3;

/**
 * Legacy Ministry.cshtml's `div.collapsible-regions`, in its order: Media Contacts, Meet the Team
 * (legacy hard-coded the Premier's three links in MoreFromThis; ours are the profile's team links,
 * for any ministry that has them), More from this Ministry ("More from the Premier" for the
 * Premier), Featured Topics, Featured Services, then one minister-of-state card per child ministry.
 * Empty groups are left out.
 */
function collapsibleRegions(site: Pick<SiteInfo, "baseUrl">, m: MinistryDto, labels: MinistryPageLabels, ctx: MinistryPageContext): string {
  const [more, topics, services] = ministryLinkGroups(m, labels);
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
 * them on a desktop and cloned them into the column with JavaScript; ours render once, and CSS
 * moves the whole column below the news on a phone. "Load More News" reveals the cards already on
 * the page (site.js).
 */
export function renderMinistryPage(m: MinistryDto, minister: MinisterDto | null, posts: CategoryPosts, site: SiteInfo, opts: PageOptions, ctx: MinistryPageContext): string {
  const key = m.key.toLowerCase();
  const base = basePath(site);
  const settings = opts.settings ?? themeDefaults(site.theme);
  const top = posts.top ? `<div class="top-article">\n${postCard(site, posts.top)}\n</div>\n` : "";
  const feature = posts.feature ? `<div class="feature-article">\n${postCard(site, posts.feature)}\n</div>\n` : "";
  const cards = posts.latest.map((p, i) => postCard(site, p, { hidden: i >= VISIBLE_LATEST }));
  const loadMore = posts.latest.length > VISIBLE_LATEST ? `<button type="button" class="load-more link-button" aria-controls="regular-articles">Load More News</button>\n` : "";
  const body = `<h1 class="ministry-name-mobile">${e(m.name)}</h1>
<div class="pt-2 ministry-listing">
<div class="home-layout">
${ministrySidebar(site, m, minister, ctx.profile, collapsibleRegions(site, m, settings.ministryPages, ctx))}
<div class="home-body" id="main-content-release">
${top}${feature}<div class="other-articles">
<div id="regular-articles" class="regular-articles">
${cards.join("\n")}
</div>
<div class="news-control">
${loadMore}<a href="${e(base)}/search/?ministry=${e(encodeURIComponent(key))}" class="read-more">Search News</a>
<div class="clear"></div>
</div>
<p><a href="${e(base)}/archive/">Browse the archive by month</a></p>
</div>
</div>
</div>
</div>`;

  return renderPage(m.name, site, pageUrl(site, { type: "category", kind: "ministries", key }), body, {
    ...opts,
    feed: { href: feedUrl(site, { type: "category", kind: "ministries", key }), title: `${site.name}: ${m.name}` },
  });
}

export function renderCategoryPage(kind: Exclude<CategoryKind, "ministries">, c: CategoryDto, posts: CategoryPosts, site: SiteInfo, opts: PageOptions = {}): string {
  const key = c.key.toLowerCase();
  const body = `<h1>${e(c.name)}</h1>
${postsSections(site, posts)}
${moreLinks(site, kind, key, c.name)}`;

  return renderPage(c.name, site, pageUrl(site, { type: "category", kind, key }), body, {
    ...opts,
    feed: { href: feedUrl(site, { type: "category", kind, key }), title: `${site.name}: ${c.name}` },
  });
}
