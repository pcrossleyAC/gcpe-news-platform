import { asc, sql } from "drizzle-orm";
import { friendlyDateRange, type ListQuery, type ListRow } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import { activities } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { idSearchOf, listWhere, scopeOf, type ListScope } from "./query";
import { rowsOf } from "./rows";
import { xlsxOf, type Run, type Sheet, type SheetCell } from "./xlsx";

export const EXPORT_ROW_LIMIT = 10_000;
export class ExportTooLargeError extends Error {
  override name = "ExportTooLargeError";
  constructor() {
    super("More than 10,000 activities match: narrow the filter and export again");
  }
}

/** Each export builds its whole workbook in memory, so this process runs at most this many at once. */
export const EXPORT_CONCURRENCY = 2;
/** Seconds a refused export is told to wait before trying again. */
export const EXPORT_RETRY_AFTER_SECONDS = 5;
/** HTTP 503 with Retry-After. */
export class ExportBusyError extends Error {
  override name = "ExportBusyError";
  constructor() {
    super("Other exports are running: try again in a few seconds");
  }
}

/** Legacy's 16 columns (ActivityHandler.ashx.cs:496-511). */
export const EXPORT_HEADERS = [
  "ID", "Ministry", "Categories", "Date & Time", "Title", "Summary", "Significance and Strategy", "Event Planner", "Scheduling Notes",
  "Comm. Materials", "Lead Org", "Comm. Contact", "Govt Rep.", "City", "Tags", "Premier Requested",
] as const;
const WIDTHS = [8, 10, 16, 20, 24, 48, 36, 16, 24, 18, 16, 20, 14, 16, 16, 14];
/** Legacy's footer (ActivityHandler.ashx.cs:513). */
export const CONFIDENTIALITY_NOTICE =
  "CONFIDENTIALITY NOTICE:  This information, including any attachments, is confidential.  It is intended only for the use of the person or persons to whom it is addressed or shared with, unless I have expressly authorized otherwise.  If you have received this data extract in error, please discard the document, including any related information or attachments, and notify the Corporate Calendar Administrator immediately by email or telephone.";
const DARK_RED = "FF8B0000";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const plain = (text: string): SheetCell => ({ runs: [{ text }], style: "cell" });
const bold = (text: string): SheetCell => ({ runs: [{ text }], style: "boldCell" });
/** Legacy's "MMM dd, yyyy" (ActivityHandler.ashx.cs:528-541). */
const headingDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)}, ${d.slice(0, 4)}`;

/** Legacy's date range; an id search ignores the dates (listWhere), so it names the activity instead. */
function dateRangeHeading(q: ListQuery, today: string): string {
  const id = q.corporate ? null : idSearchOf(q.filter.quickSearch);
  if (id !== null) return `Activity ID Selected: ${id}`;
  const from = q.corporate ? today : (q.filter.from ?? today);
  const to = q.corporate ? null : q.filter.thisDayOnly ? from : q.filter.to;
  return `Date Range Selected: ${headingDate(from)}${to ? ` to ${headingDate(to)}` : " date-forward"}`;
}

/** Legacy's "ddd, MMM d h:mm tt", in BC time. */
function printed(now: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `Printed: ${p.weekday}, ${p.month} ${p.day} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

function rowCells(r: ListRow, scope: ListScope): SheetCell[] {
  const summary: Run[] = r.isConfidential ? [{ text: "Not for Look Ahead ", color: DARK_RED }, { text: r.details }] : [{ text: r.details }];
  const significance: Run[] = r.strategy ? [{ text: r.significance }, { text: "\n\nStrategy: ", italic: true }, { text: r.strategy }] : [{ text: r.significance }];
  return [
    { number: r.id, style: "cell" },
    bold(r.ministryAbbreviation ?? ""),
    bold([...(r.isIssue ? ["Issue"] : []), ...r.categories].join(", ")),
    plain(friendlyDateRange(r, { timeZone: scope.rules.timeZone, today: scope.today, weekday: true })),
    bold(r.title),
    { runs: summary, style: "cell" },
    { runs: significance, style: "cell" },
    plain(r.eventPlanner ?? ""),
    plain(r.schedule),
    plain(r.commMaterials.join(", ")),
    plain(r.leadOrganization),
    plain(r.commContact ? [r.commContact.name, r.commContact.phone].filter(Boolean).join("\n") : ""),
    plain(r.governmentRepresentative ?? ""),
    plain([r.city ?? "", r.venue].filter(Boolean).join("\n")),
    plain(r.keywords.join(", ")),
    plain(r.premierRequested ?? ""),
  ];
}

export function exportSheet(rows: ListRow[], q: ListQuery, scope: ListScope, now: Date): Sheet {
  const banner = scope.rules.reportBanner.province;
  return {
    name: "Activities",
    widths: WIDTHS,
    rows: [
      {
        cells: [
          { runs: [{ text: `${banner}. Corporate Calendar DRAFT & CONFIDENTIAL` }], style: "banner", span: 5 },
          { runs: [{ text: dateRangeHeading(q, scope.today) }], style: "heading", span: 5 },
          { runs: [{ text: printed(now, scope.rules.timeZone) }], style: "heading", span: 4 },
        ],
      },
      { cells: EXPORT_HEADERS.map((h) => ({ runs: [{ text: h }], style: "header" as const })) },
      ...rows.map((r) => ({ cells: rowCells(r, scope) })),
      { cells: [{ runs: [{ text: CONFIDENTIALITY_NOTICE }], style: "notice", span: 10 }], height: 60 },
    ],
  };
}

/** The Excel export (spec addendum §8.1, C151): the list's visible rows, in legacy's order, as an .xlsx. */
export function exportWorkbook(deps: ApiDeps, actor: CalendarActor, q: ListQuery): Promise<Buffer> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const tz = deps.rules.timeZone;
    // Legacy orders by start date, end date, then start time (ActivityHandler.ashx.cs:46-48), whatever the list's sort.
    const ids = (
      await tx
        .select({ id: activities.id })
        .from(activities)
        .where(listWhere(scope, q))
        .orderBy(
          sql`(${activities.startAt} AT TIME ZONE ${tz})::date ASC NULLS LAST`,
          sql`(${activities.endAt} AT TIME ZONE ${tz})::date ASC NULLS LAST`,
          sql`to_char(${activities.startAt} AT TIME ZONE ${tz}, 'HH24:MI') ASC NULLS LAST`,
          asc(activities.id),
        )
        .limit(EXPORT_ROW_LIMIT + 1)
    ).map((r) => r.id);
    if (ids.length > EXPORT_ROW_LIMIT) throw new ExportTooLargeError();
    return xlsxOf(exportSheet(await rowsOf(tx, scope, ids), q, scope, await dbNow(tx, deps.now)));
  });
}
