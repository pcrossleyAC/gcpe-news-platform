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

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * "Tuesday, September 22, 2026 11:45 AM" (legacy `FormatDateLong` on a DateTimeOffset, en-CA:
 * `dddd, MMMM d, yyyy h:mm tt`) from the News API's BC-local ISO string. The wall clock is read
 * as written — the News API already converted it to America/Vancouver from the tz database — so
 * there is no time-zone maths and no hard-coded offset here. The weekday is the calendar date's,
 * via `Date.UTC`. A string without a date and time, or with an impossible one, is returned as is.
 */
export function displayDateTime(publishDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(publishDate);
  if (!m) return publishDate;
  const [y, mo, d, h, min] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), m[5]!];
  // A real calendar day (day 0 of the next month is this month's last) and clock, so an impossible
  // date never rolls over into another day's weekday.
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || Number(min) > 59) return publishDate;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${weekday}, ${MONTHS[mo - 1]} ${d}, ${m[1]} ${hour12}:${min} ${h < 12 ? "AM" : "PM"}`;
}

/** A file size as legacy `ToBytesReadable` writes it: under 1 KB is "1 KB", and everything
 * else is whole kilobytes with thousands separators — megabytes too ("4,883 KB"). */
export function bytesReadable(n: number): string {
  if (n < 1024) return "1 KB";
  return `${Math.round(n / 1024).toLocaleString("en-CA")} KB`;
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
