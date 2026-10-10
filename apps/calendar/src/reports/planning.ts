import { friendlyDateRange } from "@gcpe/calendar-contract";
import type { ReportRow } from "./data";
import { updatedNumeric } from "./dates";
import type { Cell, ReportDoc, Run } from "./model";
import { cityOf, cleanTitle, COLOURS, createdOrUpdated, linkify, minIdRuns } from "./text";
import type { ListReportContext } from "./thirty-sixty-ninety";

/** Legacy's Tags line: HQ Tags sorted, those starting "HQ" first (ActivityHandler.ashx.cs:560-566). */
export function planningTags(keywords: readonly string[]): string[] {
  const sorted = [...keywords].sort();
  return [...sorted.filter((k) => k.startsWith("HQ")), ...sorted.filter((k) => !k.startsWith("HQ"))];
}

function rowCells(row: ReportRow, c: ListReportContext): Cell[] {
  const tz = c.rules.timeZone;
  const r = c.rules.reports;
  const schedule: Run[] = [{ text: friendlyDateRange(row, { timeZone: tz, today: c.today, weekday: true }) }];
  if (row.schedule) schedule.push({ text: `\n${row.schedule}` });
  if (row.premierRequested) schedule.push({ text: "\nPremier Requested: ", bold: true, color: COLOURS.draft }, { text: row.premierRequested.replaceAll("Premier ", ""), color: COLOURS.draft });
  if (row.keywords.length) schedule.push({ text: "\nTags: ", bold: true, color: COLOURS.draft }, { text: planningTags(row.keywords).join(", "), color: COLOURS.draft });
  const city = cityOf(row, c.rules);
  const summary: Run[] = [
    { text: `${city ? `${city} - ` : ""}${cleanTitle(row.title)}`, bold: true },
    { text: "\n" },
    ...(row.isConfidential ? [{ text: "Not for Look Ahead ", bold: true, color: COLOURS.darkRed }] : []),
    { text: row.details },
  ];
  const issue = row.isIssue || row.categories.some((n) => n.includes(r.issueCategoryText));
  const fyi = !issue && row.categories.some((n) => n.includes(r.fyiOnlyCategoryText));
  const significance: Run[] = [...(issue ? [{ text: "Issue", bold: true }, { text: "\n" }] : fyi ? [{ text: "FYI Only" }, { text: "\n" }] : []), { text: row.significance }];
  return [
    { runs: schedule },
    { runs: linkify(summary) },
    { runs: significance },
    { runs: [...minIdRuns(row, c), { text: `\n${createdOrUpdated(row, c.now, tz)}`, size: 8, color: "#808080" }] },
  ];
}

/** The Planning report (spec addendum §10.5; Reports/PlanningReport.rdlc): Legal landscape, one row per activity in legacy's order. */
export function planningDoc(c: ListReportContext): ReportDoc {
  return {
    page: "legal-landscape",
    title: "Planning Report",
    header: { left: [{ text: c.rules.reports.planningTitle, bold: true, size: 14, color: COLOURS.planning }], right: [{ text: c.rules.reportBanner.confidentiality, bold: true, color: COLOURS.draft }] },
    footer: { left: [{ text: updatedNumeric(c.now, c.rules.timeZone), size: 8 }], pageNumbers: true },
    blocks: [
      {
        kind: "table",
        widths: [190, "*", 230, 92],
        header: ["Schedule", "Title & Summary", "Significance", "CC ID#"].map((text) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill: COLOURS.planning })),
        rows: c.rows.map((r) => rowCells(r, c)),
      },
    ],
  };
}
