import { friendlyDateParts, type ListQuery } from "@gcpe/calendar-contract";
import { addDays, bcMidnight } from "../time";
import { ReportTooLargeError, type ReportRow } from "./data";
import { addMonths, monthHeading, monthStart, updatedLong } from "./dates";
import { cm, inch, type Block, type Cell, type Grid, type ReportDoc, type Run } from "./model";
import { COLOURS, createdOrUpdated, filterLine, linkify, minIdRuns, titleDetailsRuns, type TextContext } from "./text";

export interface ListReportContext extends TextContext {
  rows: ReportRow[];
  q: ListQuery;
}

/** The most days a 30/60/90 covers from its snapped 1st, as the Look Ahead's: 13 months. Legacy had no cap. */
export const THIRTY_SIXTY_NINETY_MAX_DAYS = 366;

/** ActivityHandler.ashx.cs:640-661: From (or today) snapped to the 1st; no To runs 90 days; This day only, that month. */
export function thirtySixtyNinetyMonths(q: ListQuery, today: string): string[] {
  const from = monthStart(q.filter.from ?? today);
  const to = q.filter.to !== null && !q.filter.thisDayOnly ? q.filter.to : q.filter.thisDayOnly ? from : addDays(from, 90);
  if (to > addDays(from, THIRTY_SIXTY_NINETY_MAX_DAYS - 1)) throw new ReportTooLargeError("months in the range");
  const months: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);
  return months;
}

/** Monthly30_60_90Subreport.rdlc: 10 pt bold white on teal, DATE and ID/CONT centred; LightGrey lines, 2 pt padding. */
const header = (labels: [string, Cell["align"]?][]): Cell[] =>
  labels.map(([text, align]) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill: COLOURS.thirtySixtyNinety, ...(align ? { align } : {}) }));
const GRID: Grid = { colour: COLOURS.grid, width: 1, padding: 2 };

/** A friendly date with its TBC or Time TBD bold blue, as the Look Ahead's (ActivityListProvider.ashx.cs's pending span). */
export function pendingDateRuns(row: ReportRow, c: Pick<ListReportContext, "rules" | "today">, colour?: string): Run[] {
  const d = friendlyDateParts(row, { timeZone: c.rules.timeZone, today: c.today, weekday: true });
  const runs: Run[] = d.text ? [{ text: d.text, wrapAtHyphen: true, ...(colour ? { color: colour } : {}) }] : [];
  return d.pending ? [...runs, { text: `${d.text ? " " : ""}${d.pending}`, bold: true, color: COLOURS.pending }] : runs;
}

function rowCells(row: ReportRow, c: ListReportContext): Cell[] {
  const tz = c.rules.timeZone;
  // Fields!Color is on TOPIC and STRATEGY only: ID/CONT is never filled.
  const purple = row.isIssue ? { fill: COLOURS.issues } : {};
  const materials = [row.strategy, row.commMaterials.join(", ")].filter(Boolean).join("\n\n");
  const contact: Run[] = row.commContact ? [{ text: `\n${row.commContact.name}` }, { text: `\n\n${createdOrUpdated(row, c.now, tz)}`, size: 8 }] : [];
  return [
    { runs: pendingDateRuns(row, c, COLOURS.white), fill: COLOURS.thirtySixtyNinety },
    { runs: linkify(titleDetailsRuns(row, c.rules, { thirtySixtyNinety: true })), ...purple },
    { runs: materials ? [{ text: materials, size: 9 }] : [], ...purple },
    { runs: [...minIdRuns(row, c), ...contact], align: "center" },
  ];
}

/**
 * The 30/60/90 report (spec addendum §10.4; Reports/Main30_60_90Report.rdlc): one table per month.
 * Each activity appears once, in the month it starts (or the first month, if it started earlier);
 * those starting after the last month are left out, as legacy (ActivityHandler.ashx.cs:840-868).
 * A row with no start never ends a month: legacy's null StartDateTime >= the next month is false.
 */
export function thirtySixtyNinetyDoc(c: ListReportContext): ReportDoc {
  const tz = c.rules.timeZone;
  let rest = c.rows;
  const blocks: Block[] = [{ kind: "heading", runs: [{ text: "30 / 60 / 90 REPORT", bold: true }], size: 18, align: "center", spaceBefore: 2 }, ...filterLine(c)];
  thirtySixtyNinetyMonths(c.q, c.today).forEach((month, i) => {
    const next = bcMidnight(addMonths(month, 1), tz);
    const n = rest.findIndex((r) => r.startAt !== null && new Date(r.startAt) >= next);
    const mine = n === -1 ? rest : rest.slice(0, n);
    rest = rest.slice(mine.length);
    // The ReportDate group breaks the page between months; each month's heading is drawn, its subreport only with rows.
    if (i > 0) blocks.push({ kind: "pageBreak" });
    blocks.push({ kind: "heading", runs: [{ text: monthHeading(month), bold: true, color: COLOURS.planning }], size: 16, align: "center", spaceBefore: 10 });
    if (mine.length) {
      blocks.push({
        kind: "table",
        widths: [57.6, "*", 122.4, 57.6],
        header: header([["DATE", "center"], ["TOPIC"], ["STRATEGY/COMM MATERIALS"], ["ID/CONT", "center"]]),
        grid: GRID,
        rows: mine.map((r) => rowCells(r, c)),
      });
    }
  });
  return {
    page: "letter-portrait",
    // Main30_60_90Report.rdlc: 0.25 in sides, 0.5 in top, no header, a 0.51 cm footer.
    margins: [inch(0.25), inch(0.5), inch(0.25), cm(0.51181)],
    fontSize: 10,
    // The PDF title legacy's ReportViewer wrote.
    title: "Main30_60_90Report",
    header: null,
    // ExecutionTime: "DRAFT AND CONFIDENTIAL" and two spaces in Brown, then Updated, at the left; the page numbers right; 9 pt, 2 pt padding.
    footer: {
      left: [{ text: `${c.rules.reportBanner.confidentiality}  `, color: COLOURS.brown }, { text: updatedLong(c.now, tz) }],
      pageNumbers: true,
      size: 9,
      offset: cm(0.03528),
      rightOffset: cm(0.07056),
      padding: 2,
    },
    blocks,
  };
}
