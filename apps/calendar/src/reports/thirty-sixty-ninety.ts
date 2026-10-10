import { friendlyDateRange, type ListQuery } from "@gcpe/calendar-contract";
import { addDays, bcMidnight } from "../time";
import type { ReportRow } from "./data";
import { addMonths, monthHeading, monthStart, updatedLong } from "./dates";
import type { Block, Cell, ReportDoc, Run } from "./model";
import { COLOURS, createdOrUpdated, linkify, minIdRuns, titleDetailsRuns, type TextContext } from "./text";

export interface ListReportContext extends TextContext {
  rows: ReportRow[];
  q: ListQuery;
}

/** ActivityHandler.ashx.cs:640-661: From (or today) snapped to the 1st; no To runs 90 days; This day only, that month. */
export function thirtySixtyNinetyMonths(q: ListQuery, today: string): string[] {
  const from = monthStart(q.filter.from ?? today);
  const to = q.filter.to !== null && !q.filter.thisDayOnly ? q.filter.to : q.filter.thisDayOnly ? from : addDays(from, 90);
  const months: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);
  return months;
}

const header = (labels: string[]): Cell[] => labels.map((text) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill: COLOURS.thirtySixtyNinety }));

function rowCells(row: ReportRow, c: ListReportContext): Cell[] {
  const tz = c.rules.timeZone;
  const purple = row.isIssue ? { fill: COLOURS.issues } : {};
  const materials = [row.strategy, row.commMaterials.join(", ")].filter(Boolean).join("\n\n");
  const contact: Run[] = row.commContact ? [{ text: `\n${row.commContact.name}` }, { text: `\n\n${createdOrUpdated(row, c.now, tz)}`, size: 8, color: "#808080" }] : [];
  return [
    { runs: [{ text: friendlyDateRange(row, { timeZone: tz, today: c.today, weekday: true }), color: COLOURS.white }], fill: COLOURS.thirtySixtyNinety },
    { runs: linkify(titleDetailsRuns(row, c.rules, { thirtySixtyNinety: true })), ...purple },
    { runs: materials ? [{ text: materials, size: 9 }] : [], ...purple },
    { runs: [...minIdRuns(row, c), ...contact], ...purple },
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
  const blocks: Block[] = [{ kind: "heading", runs: [{ text: "30 / 60 / 90 REPORT", bold: true }], size: 16, align: "center" }];
  thirtySixtyNinetyMonths(c.q, c.today).forEach((month, i) => {
    const next = bcMidnight(addMonths(month, 1), tz);
    const n = rest.findIndex((r) => r.startAt !== null && new Date(r.startAt) >= next);
    const mine = n === -1 ? rest : rest.slice(0, n);
    rest = rest.slice(mine.length);
    // The ReportDate group breaks the page between months; each month's heading is drawn, its subreport only with rows.
    if (i > 0) blocks.push({ kind: "pageBreak" });
    blocks.push({ kind: "heading", runs: [{ text: monthHeading(month), bold: true, color: COLOURS.thirtySixtyNinety }], size: 13, align: "center", spaceBefore: 10 });
    if (mine.length) blocks.push({ kind: "table", widths: [70, "*", 120, 82], header: header(["DATE", "TOPIC", "STRATEGY/COMM MATERIALS", "ID/CONT"]), rows: mine.map((r) => rowCells(r, c)) });
  });
  return {
    page: "letter-portrait",
    title: "30 / 60 / 90 Report",
    header: null,
    footer: {
      left: [{ text: c.rules.reportBanner.confidentiality, bold: true, color: "#ff0000", size: 8 }, { text: ` ${updatedLong(c.now, tz)}`, bold: true, size: 8 }],
      pageNumbers: true,
    },
    blocks,
  };
}
