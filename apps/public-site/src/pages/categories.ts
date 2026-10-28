import type { CategoryDto, MinisterDto, MinistryDto, PostDto } from "../dto";
import { basePath, e, renderPage, safeSrc, type PageOptions, type SiteInfo } from "../render";
import { categoryPageId, feedUrl, pageUrl, parsePageId, type CategoryKind } from "../site-paths";
import { displayDate, postListItem } from "./format";
import type { MinistryPageLabels } from "@gcpe/site-settings";
import { settingsHref, themeDefaults } from "../settings";
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

interface ContactFields {
  name?: string;
  title?: string;
  phone?: string;
  email?: string;
}

/** `contactUser`/`secondContactUser` are untyped objects from Core's org record — only their
 * known string fields are ever read, each escaped before display. */
function contactFields(u: unknown): ContactFields {
  if (!u || typeof u !== "object") return {};
  const o = u as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof o[k] === "string" && o[k] ? (o[k] as string) : undefined);
  return { name: pick("name"), title: pick("title"), phone: pick("phone"), email: pick("email") };
}

function contactItem(u: unknown): string {
  const f = contactFields(u);
  const lines = [f.name, f.title, f.phone, f.email].filter((v): v is string => v !== undefined);
  return lines.length ? `<li>${lines.map(e).join("<br>")}</li>` : "";
}

function mediaContactsSection(heading: string, contactUser: unknown, secondContactUser: unknown): string {
  const items = [contactItem(contactUser), contactItem(secondContactUser)].filter(Boolean).join("\n");
  return items ? `<section>\n<h2>${e(heading)}</h2>\n<ul>\n${items}\n</ul>\n</section>` : "";
}

/** A side-column link list; links whose URL fails the settings' safe-URL rule (https or
 * site-relative; no http: or javascript:) are dropped, and a list with none left renders nothing. */
function sideLinks(site: Pick<SiteInfo, "baseUrl">, heading: string, links: { text: string; url: string | null | undefined }[]): string {
  const items = links.flatMap((l) => {
    const href = l.url ? settingsHref(l.url, site) : null;
    return href ? [`<li><a href="${e(href)}">${e(l.text)}</a></li>`] : [];
  });
  return items.length ? `<section>\n<h2>${e(heading)}</h2>\n<ul>\n${items.join("\n")}\n</ul>\n</section>` : "";
}

/** The ministry page's side column: Media Contacts, More from this Ministry, Featured Topics,
 * Featured Services (left column on wide screens, after the heading on narrow); empty groups omitted, and no `<aside>` when all are. */
function ministrySideColumn(site: Pick<SiteInfo, "baseUrl">, m: MinistryDto, labels: MinistryPageLabels): string {
  const sections = [
    mediaContactsSection(labels.mediaContacts, m.contactUser, m.secondContactUser),
    sideLinks(site, labels.moreFromMinistry, [
      { text: labels.ministryWebsite, url: m.ministryUrl },
      { text: labels.ministryPhotos, url: m.flickrUri },
      { text: labels.ministryVideos, url: m.youtubeUri },
    ]),
    sideLinks(site, labels.featuredTopics, (m.topicLinks ?? []).map((l) => ({ text: l.key, url: l.uri }))),
    sideLinks(site, labels.featuredServices, (m.serviceLinks ?? []).map((l) => ({ text: l.key, url: l.uri }))),
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
