import type { ReportRow } from "./data";
import { updatedNumeric } from "./dates";
import { cm, inch, type Cell, type ReportDoc, type Run } from "./model";
import { cityOf, cleanTitle, COLOURS, createdOrUpdated, filterLine, linkify, minIdRuns } from "./text";
import { pendingDateRuns, type ListReportContext } from "./thirty-sixty-ninety";

const byCulture = new Intl.Collator("en-CA", { sensitivity: "base" });

/** Legacy's Tags line: HQ Tags in culture order (legacy's OrderBy), those starting "HQ" first (ActivityHandler.ashx.cs:560-566). */
export function planningTags(keywords: readonly string[]): string[] {
  const sorted = [...keywords].sort(byCulture.compare);
  return [...sorted.filter((k) => k.startsWith("HQ")), ...sorted.filter((k) => !k.startsWith("HQ"))];
}

function rowCells(row: ReportRow, c: ListReportContext): Cell[] {
  const tz = c.rules.timeZone;
  const r = c.rules.reports;
  const schedule: Run[] = pendingDateRuns(row, c);
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
    { runs: [...minIdRuns(row, c), { text: `\n${createdOrUpdated(row, c.now, tz)}`, size: 9 }], align: "right" },
  ];
}

/** The Planning report (spec addendum §10.5; Reports/PlanningReport.rdlc): Legal landscape, one row per activity in legacy's order. */
export function planningDoc(c: ListReportContext): ReportDoc {
  return {
    page: "legal-landscape",
    // PlanningReport.rdlc: 35.56 x 21.59 cm, 0.5 in sides, 0.25 in top and bottom, a 0.67 cm header and a 0.51 cm footer.
    margins: [inch(0.5), inch(0.25) + cm(0.67), inch(0.5), inch(0.25) + cm(0.51181)],
    fontSize: 10,
    // The PDF title legacy's ReportViewer wrote.
    title: "PlanningReport",
    // The title (legacy's Microsoft Sans Serif) at the left; DRAFT AND CONFIDENTIAL (legacy's Verdana) 11 pt regular Brown, right, 0.11 cm lower.
    header: {
      left: [{ text: c.rules.reports.planningTitle, bold: true, size: 14, color: COLOURS.planning }],
      right: [{ text: c.rules.reportBanner.confidentiality, color: COLOURS.brown }],
      size: 11,
      offset: inch(0.25),
      rightOffset: inch(0.25) + cm(0.10908),
      padding: 2,
    },
    footer: { left: [{ text: updatedNumeric(c.now, c.rules.timeZone) }], pageNumbers: true, size: 9, offset: cm(0.03528), rightOffset: cm(0.07056), padding: 2 },
    blocks: [
      ...filterLine(c, 0),
      {
        kind: "table",
        widths: [183.6, "*", 240.4, 104],
        // 11 pt bold white on navy inside #4e648a lines; CC ID# right-aligned. The rows' lines are 0.5 pt black.
        header: [["Schedule"], ["Title & Summary"], ["Significance"], ["CC ID#", "right"]].map(([text, align]) => ({ runs: [{ text: text!, bold: true, color: COLOURS.white, size: 11 }], fill: COLOURS.planning, ...(align ? { align: align as Cell["align"] } : {}) })),
        grid: { colour: COLOURS.black, width: 0.5, headerColour: COLOURS.planningBorder, padding: 2 },
        rows: c.rows.map((r) => rowCells(r, c)),
      },
    ],
  };
}
