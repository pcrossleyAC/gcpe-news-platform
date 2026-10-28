import type { CategoryDto, MinisterDto, MinistryContactDto, MinistryDto, PostDto } from "../dto";
import { basePath, e, renderPage, safeSrc, type PageOptions, type SiteInfo } from "../render";
import { categoryPageId, feedUrl, pageUrl, parsePageId, type CategoryKind } from "../site-paths";
import { displayDate, postListItem } from "./format";
import type { MinistryPageLabels } from "@gcpe/site-settings";
import { themeDefaults } from "../settings";
import { ministryLinkGroups, sideLinks } from "./side-links";
import { sanitizeBodyHtml } from "../sanitize-body";

interface CategoryPosts {
  top: PostDto | null;
  feature: PostDto | null;
  latest: PostDto[];
}

const ENGLISH = 4105;
const english = (p: PostDto) => p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];

function postCard(site: Pick<SiteInfo, "baseUrl">, p: PostDto): string {
  const headline = english(p)?.headline ?? p.key;
  const summary = p.summary ? `<p>${e(p.summary)}</p>` : "";
  return `<div class="card"><a href="${e(pageUrl(site, { type: "post", key: p.key }))}">${e(headline)}</a> <time datetime="${e(p.publishDate)}">${e(displayDate(p.publishDate))}</time>${summary}</div>`;
}

function postsSections(site: SiteInfo, posts: CategoryPosts): string {
  const top = posts.top ? `<section>\n<h2>Top story</h2>\n${postCard(site, posts.top)}\n</section>` : "";
  const feature = posts.feature ? `<section>\n<h2>Featured</h2>\n${postCard(site, posts.feature)}\n</section>` : "";
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

/** One contact, as legacy's CommContact partial renders it: name, "Direct: <phone>",
 * "Cell: <mobile>", then the email as a mailto link. Empty when the contact has no field at all. */
function contactItem(c: MinistryContactDto | null | undefined, prefix = ""): string {
  if (!c || typeof c !== "object") return "";
  const name = contactValue(c.fullName);
  const phone = contactValue(c.phoneNumber);
  const mobile = contactValue(c.mobileNumber);
  const email = contactValue(c.emailAddress);
  const lines = [
    name !== undefined ? `<span class="contact-name">${e(name)}</span>` : "",
    phone !== undefined ? `Direct: ${e(phone)}` : "",
    mobile !== undefined ? `Cell: ${e(mobile)}` : "",
    email !== undefined ? `<a href="mailto:${e(email)}">${e(email)}</a>` : "",
  ].filter(Boolean);
  return lines.length ? `<li>${prefix}${lines.join("<br>")}</li>` : "";
}

/** Legacy (Views/Shared/Ministry.cshtml): shown only when the first contact exists; the second
 * is labelled "Alternate:", and the after-hours number comes last. */
function mediaContactsSection(heading: string, m: Pick<MinistryDto, "contactUser" | "secondContactUser" | "weekendContactNumber">): string {
  const first = contactItem(m.contactUser);
  if (!first) return "";
  const second = contactItem(m.secondContactUser, "<span>Alternate:</span><br>");
  const afterHours = contactValue(m.weekendContactNumber);
  const items = [first, second].filter(Boolean).join("\n");
  const after = afterHours !== undefined ? `\n<p>After hours: ${e(afterHours)}</p>` : "";
  return `<section>\n<h2>${e(heading)}</h2>\n<ul class="media-contacts">\n${items}\n</ul>${after}\n</section>`;
}

/** The ministry page's side column: Media Contacts, More from this Ministry, Featured Topics,
 * Featured Services (left column on wide screens, after the heading on narrow); empty groups omitted, and no `<aside>` when all are. */
function ministrySideColumn(site: Pick<SiteInfo, "baseUrl">, m: MinistryDto, labels: MinistryPageLabels): string {
  const sections = [
    mediaContactsSection(labels.mediaContacts, m),
    ...ministryLinkGroups(m, labels).map((g) => sideLinks(site, g.heading, g.links)),
  ].filter(Boolean);
  return sections.length ? `<aside aria-label="${e(`About ${m.name}`)}">\n${sections.join("\n")}\n</aside>` : "";
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

export function renderMinistryPage(m: MinistryDto, minister: MinisterDto | null, posts: CategoryPosts, site: SiteInfo, opts: PageOptions = {}): string {
  const key = m.key.toLowerCase();
  const photoSrc = minister ? safeSrc(minister.photo) : null;
  const ministerSection = minister
    ? `<section>\n<h2>Minister</h2>\n${photoSrc ? `<img src="${e(photoSrc)}" alt="${e(m.ministerName)}">` : ""}${minister.summary ? `<p>${e(minister.summary)}</p>` : ""}${sanitizeBodyHtml(minister.details ?? "")}\n</section>`
    : "";
  const settings = opts.settings ?? themeDefaults(site.theme);
  const aside = ministrySideColumn(site, m, settings.ministryPages);
  const content = `${ministerSection}
${postsSections(site, posts)}
${moreLinks(site, "ministries", key, m.name)}`;
  const body = aside
    ? `<h1>${e(m.name)}</h1>\n<div class="ministry-layout">\n${aside}\n<div class="ministry-content">\n${content}\n</div>\n</div>`
    : `<h1>${e(m.name)}</h1>\n${content}`;

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
