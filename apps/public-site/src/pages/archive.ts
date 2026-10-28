import type { GovernmentTermDto } from "../dto";
import { isLegacyOnly, legacyHref } from "../government-terms";
import type { IndexedPost } from "../post-index";
import { e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { pageUrl } from "../site-paths";
import { displayDate, monthName, postListItem } from "./format";

/** "1 post" / "n posts". */
const postCount = (count: number) => `${count} post${count === 1 ? "" : "s"}`;

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
        return `<section>\n<h2>${e(year)}</h2>\n<ul>\n${items}\n</ul>\n</section>`;
      })
      .join("\n");
  }
  const terms = `<p><a href="${e(pageUrl(site, { type: "archive-terms" }))}">Browse by government term</a></p>`;
  const body = `<h1>News archive</h1>\n${listing}\n${terms}`;
  return renderPage("News archive", site, pageUrl(site, { type: "archive" }), body, opts);
}

/** One month's posts, in the order given (the caller — `postIndex.inMonth()` — sorts them). */
export function renderArchiveMonth(month: string, posts: IndexedPost[], site: SiteInfo, opts: PageOptions = {}): string {
  const list = posts.length
    ? `<ul class="post-list">\n${posts.map((p) => postListItem(site, p)).join("\n")}\n</ul>`
    : "<p>Nothing was published this month.</p>";
  const title = `News from ${monthName(month)}`;
  const body = `<h1>${e(title)}</h1>\n${list}\n<p><a href="${e(pageUrl(site, { type: "archive" }))}">All months</a></p>`;
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
      const label = term.label ? ` ${e(term.label)}` : "";
      const legacy = legacyHref(term);
      if (isLegacyOnly(term, count)) return `<li><a href="${e(legacy)}">${e(range)} (legacy news archive)</a>${label}</li>`;
      const note = legacy && count > 0 ? `\n${legacyNote(legacy)}` : "";
      return `<li><a href="${e(pageUrl(site, { type: "archive-term", slug: term.slug }))}">${e(range)}</a>${label} (${postCount(count)})${note}</li>`;
    });
    // post-list: the listing pages' row spacing, which also keeps a link-only row's target 24px clear (axe target-size).
    listing = `<ul class="post-list term-list">\n${items.join("\n")}\n</ul>`;
  }
  // The frozen legacy archive's home, from the oldest term that links into it.
  const oldestLegacy = [...rows].reverse().map((r) => legacyHref(r.term)).find((h): h is string => h !== null);
  const closing = oldestLegacy
    ? `\n<p>Releases from before 2012 are on the legacy news archive (<a href="${e(new URL(oldestLegacy).origin)}/">${e(new URL(oldestLegacy).host)}</a>).</p>`
    : "";
  const body = `<h1>${e(title)}</h1>\n${listing}${closing}\n<p><a href="${e(pageUrl(site, { type: "archive" }))}">Browse by month</a></p>`;
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
  const list = posts.length
    ? `<ul class="post-list">\n${posts.map((p) => postListItem(site, { ...p, summary: null })).join("\n")}\n</ul>`
    : `<p>Nothing has been published in this term yet.</p>`;
  const body = `<h1>${e(title)}</h1>${label}\n${list}\n<p><a href="${e(pageUrl(site, { type: "archive-terms" }))}">All government terms</a></p>`;
  return renderPage(title, site, pageUrl(site, { type: "archive-term", slug: canonicalSlug ?? term.slug }), body, pageOpts);
}

