import type { IndexedPost } from "../post-index";
import { e, renderPage, type PageOptions, type SiteInfo } from "../render";
import { pageUrl } from "../site-paths";
import { monthName, postListItem } from "./format";

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
  const body = `<h1>News archive</h1>\n${listing}`;
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
