import type { GovernmentTermDto } from "../dto";
import { isLegacyOnly, legacyHref } from "../government-terms";
import type { IndexedPost } from "../post-index";
import { icon } from "../icons";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { themeDefaults } from "../settings";
import { pageUrl } from "../site-paths";
import { displayDate, displayDateTime, monthName } from "./format";

/** "1 post" / "n posts". */
const postCount = (count: number) => `${count} post${count === 1 ? "" : "s"}`;

/**
 * One archived post as news.gov's listing card (the markup of `postCard`, from the post index
 * alone: no thumbnail, no Media Assets or Translations links, which need the News API). The link
 * is the post's public `/releases/<key>/` (`pageUrl`), whatever the key's length; where a long
 * key's files live on disk (`postDir`) is mapped by the stack (apps/stack's legacy middleware).
 */
export function archiveCard(site: Pick<SiteInfo, "baseUrl">, p: IndexedPost): string {
  const base = e(basePath(site));
  const href = e(pageUrl(site, { type: "post", key: p.key }));
  const headline = e(p.headline);
  const summary = p.summary?.trim()
    ? p.summary.split(/\r?\n/).map((line) => `<p>${e(line)}</p>`).join("")
    : "";
  return `<div class="article">
<h2><a href="${href}">${headline}</a></h2>
<div class="list-container ps-0 pb-0">
<div class="item-date">${e(displayDateTime(p.publishDate))}</div>
</div>
<div class="item-content">
<div class="item-text">${summary}
<a href="${href}" class="read-more">${icon("caret-right", base)} Read More<span class="visually-hidden">: ${headline}</span></a>
</div>
</div>
<div class="clear"></div>
</div>`;
}

/** The cards of a month or term, all visible (no Load More: the page is the whole list). */
const cardList = (site: SiteInfo, posts: IndexedPost[]) =>
  `<div class="other-articles">\n<div class="regular-articles">\n${posts.map((p) => archiveCard(site, p)).join("\n")}\n</div>\n</div>`;

/** The pages' closing control, as the listing pages': a Search News link (legacy's `.news-control .read-more`) to /search/ filtered by `query`. */
function searchControl(site: SiteInfo, opts: PageOptions, query: string): string {
  const labels = (opts.settings ?? themeDefaults(site.theme)).navigation.labels;
  return `<div class="news-control">\n<a href="${e(`${pageUrl(site, { type: "search" })}?${query}`)}" class="read-more">${e(labels.searchNews)}</a>\n<div class="clear"></div>\n</div>`;
}

/** The archive index: every month with at least one post, grouped by year under an `h2`,
 * newest year and newest month first (months arrive already sorted — `postIndex.months()`). */
export function renderArchiveIndex(months: { month: string; count: number }[], site: SiteInfo, opts: PageOptions = {}): string {
  let listing: string;
  if (!months.length) {
    listing = "<p>Nothing has been published yet.</p>";
  } else {
    const years = new Map<string, { month: string; count: number }[]>();
    for (const m of months) {
      const year = m.month.slice(0, 4);
      const entries = years.get(year);
      if (entries) entries.push(m);
      else years.set(year, [m]);
    }
    listing = [...years]
      .map(([year, entries]) => {
        const items = entries
          .map((m) => `<li><a href="${e(pageUrl(site, { type: "archive-month", month: m.month }))}">${e(monthName(m.month))}</a> (${postCount(m.count)})</li>`)
          .join("\n");
        return `<div class="resource-links">\n<h2>${e(year)}</h2>\n<ul>\n${items}\n</ul>\n</div>`;
      })
      .join("\n");
  }
  const terms = `<p><a href="${e(pageUrl(site, { type: "archive-terms" }))}">Browse by government term</a></p>`;
  const body = `<div class="home-body archive-page">\n<h1>News archive</h1>\n${listing}\n${terms}\n</div>`;
  return renderPage("News archive", site, pageUrl(site, { type: "archive" }), body, opts);
}

/** One month's posts, in the order given (the caller — `postIndex.inMonth()` — sorts them). */
export function renderArchiveMonth(month: string, posts: IndexedPost[], site: SiteInfo, opts: PageOptions = {}): string {
  const list = posts.length ? cardList(site, posts) : "<p>Nothing was published this month.</p>";
  const title = `News from ${monthName(month)}`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const control = searchControl(site, opts, `from=${month}-01&to=${month}-${String(last).padStart(2, "0")}`);
  const body = `<div class="home-body archive-page" id="main-content-release">\n<h1>${e(title)}</h1>\n${list}\n${control}\n<p><a href="${e(pageUrl(site, { type: "archive" }))}">All months</a></p>\n</div>`;
  return renderPage(title, site, pageUrl(site, { type: "archive-month", month }), body, opts);
}

/** Spec §3, generated, never typed: "November 18, 2024 to current date" / "November 26, 2020 to November 17, 2024". */
export function termRangeLabel(startDate: string, endDate: string | null): string {
  return `${displayDate(startDate)} to ${endDate === null ? "current date" : displayDate(endDate)}`;
}

const legacyNote = (href: string) => `<p>Earlier releases from this term are on the <a href="${e(href)}">legacy news archive</a>.</p>`;

/**
 * `/archive/terms/`: the one permanent entry point a crawler follows (spec C1). One row per public
 * term, newest first (the payload's order). A legacy-only term links straight to its legacy index.
 */
export function renderTermsIndex(rows: { term: GovernmentTermDto; count: number }[], site: SiteInfo, opts: PageOptions = {}): string {
  const title = "News archive by government term";
  let listing: string;
  if (!rows.length) {
    listing = "<p>No government terms have been published yet.</p>";
  } else {
    const items = rows.map(({ term, count }) => {
      const range = termRangeLabel(term.startDate, term.endDate);
      const label = term.label ? `, ${e(term.label)}` : "";
      const legacy = legacyHref(term);
      if (isLegacyOnly(term, count)) return `<li><a href="${e(legacy)}">${e(range)} (legacy news archive)</a>${label}</li>`;
      const note = legacy && count > 0 ? `\n${legacyNote(legacy)}` : "";
      return `<li><a href="${e(pageUrl(site, { type: "archive-term", slug: term.slug }))}">${e(range)}</a>${label} (${postCount(count)})${note}</li>`;
    });
    // post-list: the listing pages' row spacing, which also keeps a link-only row's target 24px clear (axe target-size).
    listing = `<div class="resource-links">\n<ul class="post-list term-list">\n${items.join("\n")}\n</ul>\n</div>`;
  }
  // The frozen legacy archive's home, from the oldest term that links into it.
  const oldestLegacy = [...rows].reverse().map((r) => legacyHref(r.term)).find((h): h is string => h !== null);
  const closing = oldestLegacy
    ? `\n<p>Releases from before 2012 are on the legacy news archive (<a href="${e(new URL(oldestLegacy).origin)}/">${e(new URL(oldestLegacy).host)}</a>).</p>`
    : "";
  const body = `<div class="home-body archive-page">\n<h1>${e(title)}</h1>\n${listing}${closing}\n<p><a href="${e(pageUrl(site, { type: "archive" }))}">Browse by month</a></p>\n</div>`;
  return renderPage(title, site, pageUrl(site, { type: "archive-terms" }), body, opts);
}

/**
 * `/archive/terms/<slug>/` (and the `current` alias, whose canonical is the slug page, spec N6):
 * the range, the label, then every post in the term, newest first (the caller sorts). One page,
 * no pagination (N5).
 */
export function renderTermPage(term: GovernmentTermDto, posts: IndexedPost[], site: SiteInfo, opts: PageOptions & { canonicalSlug?: string }): string {
  const { canonicalSlug, ...pageOpts } = opts;
  const title = `News from ${termRangeLabel(term.startDate, term.endDate)}`;
  const label = term.label ? `\n<p>${e(term.label)}</p>` : "";
  const legacy = legacyHref(term);
  const note = legacy && posts.length > 0 ? `\n${legacyNote(legacy)}` : "";
  const list = posts.length ? cardList(site, posts) : `<p>Nothing has been published in this term yet.</p>`;
  // An open term has no `to`: the search page's own term links do the same, and the page never goes stale.
  const control = searchControl(site, pageOpts, `from=${term.startDate}${term.endDate ? `&to=${term.endDate}` : ""}`);
  const body = `<div class="home-body archive-page" id="main-content-release">\n<h1>${e(title)}</h1>${label}${note}\n${list}\n${control}\n<p><a href="${e(pageUrl(site, { type: "archive-terms" }))}">All government terms</a></p>\n</div>`;
  return renderPage(title, site, pageUrl(site, { type: "archive-term", slug: canonicalSlug ?? term.slug }), body, pageOpts);
}

