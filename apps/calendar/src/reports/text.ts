import { friendlySpan, sameCategoryName, type CalendarRules } from "@gcpe/calendar-contract";
import { addDays, wallClock } from "../time";
import type { ReportRow } from "./data";
import { clockTime } from "./dates";
import type { Run } from "./model";

/** Legacy's report colours (docs/parity/legacy-report-layouts.md, pixel-verified where it says so). */
export const COLOURS = {
  events: "#558abd",
  issues: "#ccc0d9",
  issuesDate: "#f2dbdb",
  news: "#e8f3a9",
  awareness: "#eaf1dd",
  outlook: "#edf2f8",
  outlookHeader: "#9e3a38",
  listHeader: "#000000",
  thirtySixtyNinety: "#35989d",
  planning: "#384c70",
  white: "#ffffff",
  zebra: "#d9d9d9",
  heading: "#365f91",
  draft: "#9e3a38",
  /** The 30/60/90's and Planning's "DRAFT AND CONFIDENTIAL" (the RDLCs' Brown). */
  brown: "#a52a2a",
  banner: "#595959",
  darkRed: "#8b0000",
  seaGreen: "#2e8b57",
  flag: "#ffa500",
  link: "#0000ee",
  pending: "#1919d2",
  lastUpdated: "#cf7a50",
} as const;

/** What turns a row into report text: the tenant's rules, the viewer's HQ flag, the clock and the staff app's origin. */
export interface TextContext {
  rules: CalendarRules;
  /** Legacy's IsAppOwner: the HQ variant of the Look Ahead. */
  isHq: boolean;
  now: Date;
  /** Today's BC date. */
  today: string;
  /** "https://host" of the staff app, for each row's link; null leaves the CC ID# unlinked. */
  origin: string | null;
}

/**
 * A title without the raw `**CONFIDENTIAL**` marker, which legacy printed asterisks and all
 * (docs/parity/legacy-report-layouts.md, discrepancy 8).
 */
export function cleanTitle(title: string): string {
  return title.replace(/\*\*\s*confidential\s*\*\*/gi, " ").replace(/\s+/g, " ").trim();
}

/** The city for a title, without the tenant's suffix; null when there is none or it is the "to be decided" city. */
export function cityOf(row: Pick<ReportRow, "city">, rules: CalendarRules): string | null {
  if (!row.city || row.city === rules.reports.cityToBeDecidedName) return null;
  const city = rules.reports.citySuffix ? row.city.replaceAll(rules.reports.citySuffix, "") : row.city;
  return city.trim() || null;
}

/** Legacy's FormatTitle: "City - Title". */
export function formatTitle(row: Pick<ReportRow, "city" | "title">, rules: CalendarRules): string {
  const city = cityOf(row, rules);
  return `${city ? `${city} - ` : ""}${cleanTitle(row.title)}`;
}

const BOLD_OPEN = "\uE000";
const BOLD_CLOSE = "\uE001";
const ITALIC_OPEN = "\uE002";
const ITALIC_CLOSE = "\uE003";

/**
 * Legacy's FormatHqComments (ActivityHandler.ashx.cs:1087-1112): `**bold**`, then `_italic_`,
 * pair by pair; null for an empty one or the clone's bare "**".
 */
export function executiveSummaryRuns(summary: string | null): Run[] | null {
  if (summary === null || summary.length <= 2) return null;
  let s = summary.replace(/[\uE000-\uE003]/g, "");
  for (;;) {
    let marker = "**";
    let start = s.indexOf(marker);
    if (start === -1) {
      marker = "_";
      start = s.indexOf(marker);
    }
    if (start === -1) break;
    const end = s.indexOf(marker, start + marker.length);
    if (end === -1) break;
    const [open, close] = marker === "_" ? [ITALIC_OPEN, ITALIC_CLOSE] : [BOLD_OPEN, BOLD_CLOSE];
    s = `${s.slice(0, start)}${open}${s.slice(start + marker.length, end)}${close}${s.slice(end + marker.length)}`;
  }
  const out: Run[] = [];
  let bold = 0;
  let italic = 0;
  for (const part of s.replace(/\r\n/g, "\n").split(/([\uE000-\uE003])/)) {
    if (part === BOLD_OPEN) bold++;
    else if (part === BOLD_CLOSE) bold--;
    else if (part === ITALIC_OPEN) italic++;
    else if (part === ITALIC_CLOSE) italic--;
    else if (part) out.push({ text: part, ...(bold > 0 ? { bold: true } : {}), ...(italic > 0 ? { italic: true } : {}) });
  }
  return out;
}

function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    const a = Math.max(from, pos);
    const b = Math.min(to, end);
    if (a < b) out.push({ ...r, text: r.text.slice(a - pos, b - pos) });
    pos = end;
  }
  return out;
}

/**
 * Legacy's AddNewDetailsRow (ActivityHandler.ashx.cs:1063-1085): the first http:// (else https://)
 * address becomes a link. Its text is a "[label]" written just before it, else the address, an
 * http:// one without its scheme.
 */
export function linkify(runs: Run[]): Run[] {
  const text = runs.map((r) => r.text).join("");
  let start = text.indexOf("http://");
  const isHttp = start !== -1;
  if (!isHttp) start = text.indexOf("https://");
  if (start === -1) return runs;
  const stop = /[\s<]/.exec(text.slice(start));
  const end = stop ? start + stop.index : text.length;
  const url = text.slice(start, end).replace(/\/+$/, "");
  if (url.length <= "http://".length) return runs;
  let label = isHttp ? url.slice("http://".length) : url;
  let keep = start;
  const before = text.slice(0, start);
  if (before.endsWith("]")) {
    const open = before.indexOf("[");
    if (open !== -1) {
      label = before.slice(open + 1, -1);
      keep = open;
    }
  }
  return [...sliceRuns(runs, 0, keep), { text: label, link: url, underline: true, color: COLOURS.link }, ...sliceRuns(runs, end, text.length)];
}

/** Legacy's FormatInitiative: the short names, sea-green. */
export function initiativeRuns(row: Pick<ReportRow, "initiatives">): Run[] {
  return row.initiatives.length ? [{ text: ` ${row.initiatives.join(", ")}`, color: COLOURS.seaGreen }] : [];
}

/**
 * Legacy's FormatTitleDetails (ActivityHandler.ashx.cs:1114-1128): "**City - Title**: details",
 * the red "Not for Look Ahead" before the details; the 30/60/90 adds the significance and sets
 * the details at 9 pt.
 */
export function titleDetailsRuns(row: ReportRow, rules: CalendarRules, o: { thirtySixtyNinety: boolean }): Run[] {
  const size = o.thirtySixtyNinety ? { size: 9 } : {};
  const body: Run[] = [
    ...(row.isConfidential ? [{ text: "Not for Look Ahead ", color: COLOURS.darkRed, ...size }] : []),
    { text: row.details, ...size },
    ...(o.thirtySixtyNinety && row.significance ? [{ text: "\nSignificance: ", italic: true, ...size }, { text: row.significance, ...size }] : []),
  ];
  return [{ text: formatTitle(row, rules), bold: true }, { text: ": " }, ...body];
}

/** The Look Ahead's row text: the Executive Summary where the viewer sees it, else the title and details, then the initiatives. */
export function lookAheadText(row: ReportRow, rules: CalendarRules, o: { titleOnly: boolean }): Run[] {
  const summary = executiveSummaryRuns(row.executiveSummary);
  const text = summary ?? (o.titleOnly ? [{ text: formatTitle(row, rules), bold: true }] : titleDetailsRuns(row, rules, { thirtySixtyNinety: false }));
  return linkify([...text, ...initiativeRuns(row)]);
}

/** "today at 3:15 PM", "yesterday at …", or "2 months ago", by the BC calendar. */
function whenText(at: Date, now: Date, timeZone: string, withTime: boolean): string {
  const day = wallClock(at, timeZone).date;
  const today = wallClock(now, timeZone).date;
  if (withTime && day === today) return `today at ${clockTime(at, timeZone)}`;
  if (day === addDays(today, -1)) return withTime ? `yesterday at ${clockTime(at, timeZone)}` : "yesterday";
  return `${friendlySpan(at, now, timeZone).toLowerCase()} ago`;
}

/** Legacy's GetCreatedOrUpdatedMessage (ActivityListProvider.ashx.cs:669-688): "created 3 days ago", "updated yesterday". */
export function createdOrUpdated(row: Pick<ReportRow, "status" | "createdAt" | "lastUpdatedAt">, now: Date, timeZone: string): string {
  const isNew = row.status === "new";
  return `${isNew ? "created" : "updated"} ${whenText(new Date(isNew ? row.createdAt : row.lastUpdatedAt), now, timeZone, false)}`;
}

/** The Exec Look Ahead's "Last updated …", once ("Last updated updated" was legacy's, discrepancy 5). */
export function lastUpdatedText(row: Pick<ReportRow, "lastUpdatedAt">, now: Date, timeZone: string): string {
  return `Last updated ${whenText(new Date(row.lastUpdatedAt), now, timeZone, true)}`;
}

/**
 * The Exec Look Ahead's row (ActivityHandler.ashx.cs:984-1035): the title, details, significance,
 * "City: Venue" and when it was last updated. The city is the one shown everywhere else, the typed
 * Other City included (legacy printed "Other...").
 */
export function detailedRuns(row: ReportRow, c: TextContext): Run[] {
  const city = row.city ? (c.rules.reports.citySuffix ? row.city.replaceAll(c.rules.reports.citySuffix, "").trim() : row.city) : "";
  const cityVenue = [city, row.venue].filter(Boolean).join(": ");
  const runs: Run[] = [{ text: cleanTitle(row.title), bold: true }];
  if (row.details) runs.push({ text: `\n${row.details}` });
  if (row.significance) runs.push({ text: `\n${row.significance}` });
  // Legacy ends only the significance with a line break; without one, City: Venue follows the details after a space.
  if (cityVenue) runs.push({ text: row.significance ? "\n" : " " }, { text: cityVenue, bold: true });
  runs.push({ text: cityVenue ? "  " : "\n" }, { text: lastUpdatedText(row, c.now, c.rules.timeZone), size: 8, color: COLOURS.lastUpdated });
  return linkify(runs);
}

/** Legacy's FormatFlag: NEW or CHANGED in orange, from the LA status the viewer may see. */
export function flagRuns(row: Pick<ReportRow, "hqStatus">): Run[] {
  return row.hqStatus ? [{ text: `\n${row.hqStatus.toUpperCase()}`, bold: true, color: COLOURS.flag }] : [];
}

/** The Lead column and the CC ID#'s prefix: the ministry's abbreviation, mapped as the tenant says (GCPEHQ → HQ). */
export function leadOf(row: Pick<ReportRow, "ministryAbbreviation">, rules: CalendarRules): string {
  const abbr = row.ministryAbbreviation ?? "";
  return rules.reports.leadAbbreviations[abbr] ?? abbr;
}

/** "MIN-Id", blue, linked to the activity in the staff app (carry-forward § 5g). */
export function minIdRuns(row: Pick<ReportRow, "id" | "ministryAbbreviation">, c: Pick<TextContext, "rules" | "origin">): Run[] {
  return [{ text: `${leadOf(row, c.rules)}-${row.id}`, color: COLOURS.link, ...(c.origin ? { link: `${c.origin}/hub/calendar/activities/${row.id}` } : {}) }];
}

/** Which Look Ahead table a row is in: legacy's `inTheNews` is true for Issues and Reports and for In the News. */
export type LookAheadTable = "events" | "issues" | "news";

/**
 * Legacy's FormatLookAheadRelease (ActivityHandler.ashx.cs:1176-1257): the origin's code above the
 * material's code, then the NR time when it differs from the start and falls on that day; "-" for none.
 */
export function rlsLines(row: ReportRow, rules: CalendarRules, o: { table: LookAheadTable; day: string | null }): string[] {
  const lines: string[] = [];
  const found = (rule: { contains: readonly string[] }, text: string) => rule.contains.some((c) => text.includes(c));
  const origins = row.nrOrigins.join(", ");
  const origin = origins ? rules.reports.rlsOrigins.find((r) => found(r, origins)) : undefined;
  if (origin) lines.push(origin.code);
  const materials = row.commMaterials.join(", ");
  const material = materials ? rules.reports.rlsMaterials.find((r) => !(r.notInEvents && o.table === "events") && found(r, materials)) : undefined;
  if (material) {
    lines.push(material.code);
    const nr = row.nrAt ? new Date(row.nrAt) : null;
    if (nr && material.releaseTime !== false && o.day !== null && row.nrAt !== row.startAt && wallClock(nr, rules.timeZone).date === o.day) {
      lines.push(clockTime(nr, rules.timeZone).toLowerCase());
    }
  }
  return lines.length ? lines : ["-"];
}

/** The Category column (ActivityHandler.ashx.cs:1046-1058): Issue; for HQ, FYI unless it is only the TV/Radio category; else the names. */
export function categoryText(row: Pick<ReportRow, "isIssue" | "categories">, rules: CalendarRules, isHq: boolean): string {
  if (row.isIssue) return "Issue";
  const tvRadioOnly = row.categories.length === 1 && sameCategoryName(row.categories[0]!, rules.reports.tvRadioCategoryName);
  if (isHq && !tvRadioOnly) return "FYI";
  return row.categories.join(", ");
}
