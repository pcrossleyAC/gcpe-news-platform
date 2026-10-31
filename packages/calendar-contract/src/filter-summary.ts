import type { CorporateQuery, CorporateStatus, ListDisplay, ListOptions, ListQuery, LookAheadFilter } from "./list";

/** The list's Display choices, as the Filters panel names them. */
export const DISPLAY_LABELS: Readonly<Record<ListDisplay, string>> = {
  all: "Show All", my_ministries: "My Ministries' Activities Only", my_activities: "My Activities Only", my_watchlist: "My Watchlist Only",
};
const STATUS_LABELS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
/**
 * The Look Ahead (Confidential) filter. Legacy's "Look Ahead Only" and "Not for Look Ahead Only" mean
 * not confidential and confidential (form-order audit #7), so they are named for what they do.
 */
export const LOOK_AHEAD_LABELS: Readonly<Record<LookAheadFilter, string>> = { all: "Show All", look_ahead_only: "Not confidential only", not_for_look_ahead_only: "Confidential only" };
/** Corporate Queries' status labels. */
export const CORPORATE_LABELS: Readonly<Record<CorporateStatus, string>> = { new: "New", changed: "Changed", reviewed: "Reviewed", deleted: "Deleted", la_new: "LA New", la_changed: "LA Changed" };
/** A value the query still filters by after its lookup row went away. */
export const FILTER_VALUE_GONE = "(no longer available)";

/** Legacy searched by id only above this; a smaller number is a word, such as a year (ActivityDAO.cs:68-76). */
export const ID_SEARCH_FLOOR = 10_000;
const INT4_MAX = 2_147_483_647;

/** The activity a quick search names: a bare number above 10,000, or the list's "ABBR-123" at any size. It ignores every other filter and the dates. */
export function idSearchOf(term: string): number | null {
  const m = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d{1,10})$/.exec(term.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (n < 1 || n > INT4_MAX) return null;
  return m[1] !== undefined || n > ID_SEARCH_FLOOR ? n : null;
}

/** A corporate query in words: "next 8 days, New and Changed", "all upcoming, Deleted". */
export function corporateSummary(c: CorporateQuery): string {
  const statuses = c.statuses.map((s) => CORPORATE_LABELS[s]);
  const list = statuses.length > 1 ? `${statuses.slice(0, -1).join(", ")} and ${statuses.at(-1)}` : statuses[0];
  return `${c.days === null ? "all upcoming" : `next ${c.days} ${c.days === 1 ? "day" : "days"}`}, ${list}`;
}

const nameOf = (xs: { id: number; name: string }[], id: number | null) => (id === null ? null : (xs.find((x) => x.id === id)?.name ?? FILTER_VALUE_GONE));

/**
 * The filter the list is running, as short "Label: value" parts ("Lead Ministry: HLTH",
 * "Dates: 2026-11-01 to 2026-11-14"), for the closed Filters disclosure, the Export and reports
 * panel, and each report and export (suite review CAL-3). Empty when nothing narrows the list.
 * It follows what the server lists by (listWhere): a corporate query replaces the filter and the
 * display; an activity number in Search for replaces both too, while the Confidential filter still applies.
 */
export function activeFilterParts(query: ListQuery, options: ListOptions): string[] {
  if (query.corporate) return [`Corporate query: ${corporateSummary(query.corporate)}`];
  const f = query.filter;
  const parts: string[] = [];
  if (idSearchOf(f.quickSearch) !== null) {
    parts.push(`Activity number: ${f.quickSearch.trim()} only`);
  } else {
    if (f.thisDayOnly && f.from) parts.push(`Date: ${f.from}`);
    else if (f.from && f.to) parts.push(`Dates: ${f.from} to ${f.to}`);
    else if (f.from) parts.push(`From ${f.from}`);
    else if (f.to) parts.push(`To ${f.to}`);
    if (f.quickSearch) parts.push(`Search: “${f.quickSearch}”`);
    if (f.keywordIds.length) parts.push(`HQ Tags: ${f.keywordIds.map((id) => nameOf(options.keywords, id)).join(", ")}`);
    if (f.isIssue !== null) parts.push(f.isIssue ? "Is an Issue" : "Not an Issue");
    if (f.dateConfirmed !== null) parts.push(f.dateConfirmed ? "Date is Confirmed" : "Date is not Confirmed");
    if (f.status) parts.push(`Status: ${STATUS_LABELS[f.status]}`);
    if (f.categoryId !== null) parts.push(`Category: ${nameOf(options.categories, f.categoryId)}`);
    if (f.ministryKey) {
      const m = options.ministries.find((x) => x.key === f.ministryKey);
      parts.push(`Lead Ministry: ${m ? (m.abbreviation ?? m.name) : FILTER_VALUE_GONE}`);
    }
    if (f.commContactUserId) parts.push(`Comm Contact: ${options.commContacts.find((c) => c.userId === f.commContactUserId)?.name ?? FILTER_VALUE_GONE}`);
    if (f.representativeId !== null) parts.push(`Representative: ${nameOf(options.representatives, f.representativeId)}`);
    if (f.initiativeId !== null) parts.push(`HQ Initiatives & Leads: ${nameOf(options.initiatives, f.initiativeId)}`);
    if (f.premierRequestedId !== null) parts.push(`Premier Requested: ${nameOf(options.premierRequested, f.premierRequestedId)}`);
    if (f.distributionId !== null) parts.push(`Distribution: ${nameOf(options.distributions, f.distributionId)}`);
    if (query.display !== "all") parts.push(DISPLAY_LABELS[query.display]);
  }
  // The Confidential filter sits outside the panel and applies at once, but it narrows the list too (form-order audit #14).
  if (query.lookAhead !== "all") parts.push(LOOK_AHEAD_LABELS[query.lookAhead]);
  return parts;
}

/** One line: the parts, or that nothing narrows it. Printed under each report's heading and in the export. */
export function filterSummary(query: ListQuery, options: ListOptions): string {
  const parts = activeFilterParts(query, options);
  return parts.length ? parts.join(" · ") : "none (every activity you can see)";
}

/**
 * What can quietly narrow a report or export without the user having just chosen it (suite review
 * CAL-3): an activity number left in Search for, and a Display choice the list keeps from last time.
 */
export function filterWarnings(query: ListQuery): string[] {
  if (query.corporate) return [];
  if (idSearchOf(query.filter.quickSearch) !== null) return ["Search for holds an activity number, so only that activity is included: the dates and other filters are ignored."];
  return query.display === "all" ? [] : [`Display is set to ${DISPLAY_LABELS[query.display]}, which the list keeps from last time, so other activities are left out.`];
}
