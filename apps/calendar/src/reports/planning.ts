import { friendlyDateRange } from "@gcpe/calendar-contract";
import type { ReportRow } from "./data";
import { updatedNumeric } from "./dates";
import type { Cell, ReportDoc, Run } from "./model";
import { cityOf, cleanTitle, COLOURS, createdOrUpdated, linkify, minIdRuns } from "./text";
import type { ListReportContext } from "./thirty-sixty-ninety";

const byCulture = new Intl.Collator("en-CA", { sensitivity: "base" });

/** Legacy's Tags line: HQ Tags in culture order (legacy's OrderBy), those starting "HQ" first (ActivityHandler.ashx.cs:560-566). */
export function planningTags(keywords: readonly string[]): string[] {
  const sorted = [...keywords].sort(byCulture.compare);
  return [...sorted.filter((k) => k.startsWith("HQ")), ...sorted.filter((k) => !k.startsWith("HQ"))];
}

function rowCells(row: ReportRow, c: ListReportContext): Cell[] {
  const tz = c.rules.timeZone;
  const r = c.rules.reports;
  const schedule: Run[] = [{ text: friendlyDateRange(row, { timeZone: tz, today: c.today, weekday: true }) }];
  if (row.schedule) schedule.push({ text: `\n${row.schedule}` });
  // ActivityHandler.ashx.cs:567: the Premier/Tags block opens with its own <br>, leaving a blank line.
  const tags: Run[] = [];
  if (row.premierRequested) tags.push({ text: "\nPremier Requested: ", bold: true, color: COLOURS.lastUpdated }, { text: row.premierRequested.replaceAll("Premier ", ""), color: COLOURS.lastUpdated });
  if (row.keywords.length) tags.push({ text: "\nTags: ", bold: true, color: COLOURS.lastUpdated }, { text: planningTags(row.keywords).join(", "), color: COLOURS.lastUpdated });
  if (tags.length) schedule.push({ ...tags[0]!, text: `\n${tags[0]!.text}` }, ...tags.slice(1));
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
    { runs: [...minIdRuns(row, c), { text: `\n${createdOrUpdated(row, c.now, tz)}`, size: 9 }] },
  ];
}

/** The Planning report (spec addendum §10.5; Reports/PlanningReport.rdlc): Legal landscape, one row per activity in legacy's order. */
export function planningDoc(c: ListReportContext): ReportDoc {
  return {
    page: "legal-landscape",
    title: "Planning Report",
    header: { left: [{ text: c.rules.reports.planningTitle, bold: true, size: 14, color: COLOURS.planning }], right: [{ text: c.rules.reportBanner.confidentiality, color: COLOURS.brown, size: 11 }] },
    footer: { left: [{ text: updatedNumeric(c.now, c.rules.timeZone), size: 9 }], pageNumbers: true },
    blocks: [
      {
        kind: "table",
        widths: [183.6, "*", 240.4, 104],
        header: ["Schedule", "Title & Summary", "Significance", "CC ID#"].map((text) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill: COLOURS.planning })),
        rows: c.rows.map((r) => rowCells(r, c)),
      },
    ],
  };
}
