import { e, type SiteInfo } from "../render";
import { pageUrl } from "../site-paths";

/** How many of the latest posts a home or category page lists (spec §6.1). */
export const LATEST_COUNT = 20;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 3, 2026" from the News API's BC-local date: the calendar date as written, no time-zone maths. */
export function displayDate(publishDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(publishDate);
  if (!m) return publishDate;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export const monthName = (month: string) => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

export function postListItem(site: Pick<SiteInfo, "baseUrl">, p: { key: string; headline: string; publishDate: string; summary?: string | null }): string {
  const summary = p.summary ? `<p>${e(p.summary)}</p>` : "";
  return `<li><a href="${e(pageUrl(site, { type: "post", key: p.key }))}">${e(p.headline)}</a> <time datetime="${e(p.publishDate)}">${e(displayDate(p.publishDate))}</time>${summary}</li>`;
}

/** h1→h2 … h5→h6 (h6 stays), so staff HTML inside a page never adds a second h1. */
export function demoteHeadings(html: string): string {
  return html.replace(/<(\/?)h([1-6])(?=[\s>])/gi, (_m, slash: string, level: string) => `<${slash}h${Math.min(Number(level) + 1, 6)}`);
}
