import { describe, expect, it } from "vitest";
import { listQuerySchema } from "@gcpe/calendar-contract";
import { TEST_RULES } from "../../test/helpers";
import { bc, reportRow } from "../../test/report-rows";
import { readXlsx } from "../../test/xlsx-read";
import { EXPORT_HEADERS, EXPORT_NAME, exportCategories, exportDateRuns, exportSheet } from "./export";
import type { ListScope } from "./query";
import { xlsxOf } from "./xlsx";

// Fictional rows; only the rules and today of the scope are read.
const scope = { rules: TEST_RULES, today: "2026-11-03" } as ListScope;
const NOW = new Date("2026-11-03T18:00:00Z");
const NB = " ";

describe("the Excel export's cells, as legacy's (ActivityHandler.ashx.cs:425-470)", () => {
  it("Date & Time: no-break spaces inside each date and time, a space before every dash, TBC and Time TBD bold #1919d2", () => {
    expect(exportDateRuns(reportRow(), scope)).toEqual([{ text: `Tue${NB}Nov${NB}10 9:00 -10:00${NB}AM` }]);
    expect(exportDateRuns(reportRow({ startAt: bc("2026-11-10", "09:00"), endAt: bc("2026-11-12", "10:00") }), scope)).toEqual([{ text: `Nov${NB}10 -12` }]);
    expect(exportDateRuns(reportRow({ isConfirmed: false }), scope)).toEqual([{ text: `Tue${NB}Nov${NB}10 9:00 -10:00${NB}AM ` }, { text: "TBC", bold: true, color: "FF1919D2" }]);
    expect(exportDateRuns(reportRow({ isConfirmed: false, startAt: bc("2026-11-10", "08:00"), endAt: bc("2026-11-10", "18:00") }), scope)).toEqual([
      { text: `Tue${NB}Nov${NB}10 ` }, { text: "Time TBD", bold: true, color: "FF1919D2" },
    ]);
  });

  it("Categories: an Issue's starts with Issue and drops the FYI Only category; anyone else's are as they are", () => {
    expect(exportCategories({ isIssue: true, categories: ["Sample plain category", "Sample FYI only"] }, scope)).toBe("Issue, Sample plain category");
    expect(exportCategories({ isIssue: true, categories: ["Sample FYI only"] }, scope)).toBe("Issue");
    expect(exportCategories({ isIssue: true, categories: [] }, scope)).toBe("Issue");
    expect(exportCategories({ isIssue: false, categories: ["Sample plain category", "Sample FYI only"] }, scope)).toBe("Sample plain category, Sample FYI only");
  });
});

describe("the Excel export's look, as legacy's", () => {
  const sheet = exportSheet([reportRow({ isConfirmed: false })], listQuerySchema.parse({}), scope, NOW, "none");
  const { files, cells } = readXlsx(xlsxOf(sheet));
  const sheetXml = files.get("xl/worksheets/sheet1.xml")!;
  const styles = files.get("xl/styles.xml")!;
  const xfs = [...styles.matchAll(/<xf [^>]*?(?:\/>|>.*?<\/xf>)/g)].map((m) => m[0]).slice(1);
  const fonts = [...styles.matchAll(/<font>.*?<\/font>/g)].map((m) => m[0]);
  const styleOf = (ref: string) => xfs[Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(sheetXml)![1])]!;
  const fontOf = (xf: string) => fonts[Number(/fontId="(\d+)"/.exec(xf)![1])]!;

  it("the sheet is named as legacy's file, BCGovernmentActivities", () => {
    expect(EXPORT_NAME).toBe("BCGovernmentActivities");
    expect(files.get("xl/workbook.xml")).toContain('<sheet name="BCGovernmentActivities"');
  });

  it("the header row: white bold 11 pt on #31869b, left-aligned, turned 45 degrees, 85 pt high", () => {
    expect(EXPORT_HEADERS.map((_, i) => cells.get(`${String.fromCharCode(65 + i)}2`))).toEqual([...EXPORT_HEADERS]);
    const xf = styleOf("A2");
    expect(xf).toMatch(/fillId="2"/);
    expect(styles).toContain('<fgColor rgb="FF31869B"/>');
    expect(xf).toContain('horizontal="left"');
    expect(xf).toContain('textRotation="45"');
    expect(fontOf(xf)).toBe('<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>');
    expect(sheetXml).toContain('<row r="2" ht="85" customHeight="1">');
  });

  it("cells: thin #d3d3d3 borders, top-aligned; the footer notice red and bold", () => {
    expect(styleOf("A3")).toMatch(/borderId="1"/);
    expect(styles).toContain('<left style="thin"><color rgb="FFD3D3D3"/></left>');
    expect(styleOf("A3")).toContain('vertical="top"');
    const notice = fontOf(styleOf("A4"));
    expect(notice).toContain("<b/>");
    expect(notice).toContain('rgb="FFFF0000"');
    // The Filter row stays after legacy's footer.
    expect(cells.get("A5")).toBe("Filter: none");
  });

  it("Date & Time keeps its no-break spaces and its bold blue TBC in the file", () => {
    expect(cells.get("D3")).toBe(`Tue${NB}Nov${NB}10 9:00 -10:00${NB}AM TBC`);
    expect(sheetXml).toMatch(/<r><rPr><b\/><color rgb="FF1919D2"\/>.*?<t xml:space="preserve">TBC<\/t><\/r>/);
  });
});
