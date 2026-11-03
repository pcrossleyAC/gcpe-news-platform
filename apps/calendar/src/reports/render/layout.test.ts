import { describe, expect, it } from "vitest";
import { listQuerySchema } from "@gcpe/calendar-contract";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { pdfPages } from "../../../test/pdf-text";
import { TEST_RULES } from "../../../test/helpers";
import { bc, reportRow } from "../../../test/report-rows";
import type { ReportRow } from "../data";
import { lookAheadDoc } from "../look-ahead";
import type { ReportDoc, TableBlock } from "../model";
import { planningDoc } from "../planning";
import { COLOURS } from "../text";
import { thirtySixtyNinetyDoc } from "../thirty-sixty-ninety";
import { reportAssets } from "./assets";
import { woffToSfnt } from "./fonts";
import { docDefinitionOf, imagesOf } from "./layout";
import { renderPdf, useBcSans } from "./pdf";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { fontsDir, imagesDir } = reportAssets();
const GRID = { colour: "#d3d3d3", width: 1, padding: 2 };
const table = (rows: number, fill?: string): TableBlock => ({
  kind: "table",
  widths: [60, "*", 60],
  header: ["Date", "Activity/Details", "CC ID#"].map((text) => ({ runs: [{ text, bold: true, color: "#ffffff" }], fill: "#558abd" })),
  grid: GRID,
  rows: Array.from({ length: rows }, (_, i) => [{ runs: [{ text: `Day ${i}` }] }, { runs: [{ text: `Sample row ${i} with fictional details` }], ...(fill ? { fill } : {}) }, { runs: [{ text: `HLTH-${20001 + i}`, link: `https://staff.example.test/hub/calendar/activities/${20001 + i}` }] }]),
});
const running = { size: 9, offset: 14 };
const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  page: "letter-portrait",
  margins: [18, 57, 18, 14.5],
  fontSize: 10,
  title: "Sample report",
  firstPage: { header: { right: [{ text: "Sample first page header" }], ...running }, footer: null },
  header: { left: [{ text: "Sample Province" }], right: [{ text: "DRAFT AND CONFIDENTIAL" }], ...running },
  footer: { left: [{ text: "Updated sample" }], pageNumbers: true, ...running, offset: 1 },
  blocks: [{ kind: "heading", runs: [{ text: "Sample first page" }], size: 14 }, { kind: "pageBreak" }, { kind: "heading", runs: [{ text: "Sample second page" }], size: 14 }, table(80, "#ccc0d9")],
  ...over,
});

describe("BC Sans, embedded (spec addendum §10.1)", () => {
  it("each WOFF face unpacks to a TrueType font with the same tables", () => {
    const woff = readFileSync(join(fontsDir, "BCSans-Regular.woff"));
    const sfnt = woffToSfnt(woff);
    expect(sfnt.readUInt32BE(0)).toBe(woff.readUInt32BE(4));
    expect(sfnt.readUInt16BE(4)).toBe(woff.readUInt16BE(12));
    expect(() => woffToSfnt(Buffer.from("not a font at all, just some sample text here....."))).toThrow("not a WOFF font");
  });
});

type Node = Record<string, unknown> & { table?: { body: Node[][]; widths: unknown[]; headerRows: number; keepWithHeaderRows?: number }; text?: unknown; stack?: Node[]; columns?: Node[] };
const nodes = (def: TDocumentDefinitions) => def.content as Node[];
const tablesOf = (def: TDocumentDefinitions) => nodes(def).filter((n) => n.table);
const runsOf = (n: Node) => (Array.isArray(n.text) ? (n.text as { text: string }[]) : n.stack ? (n.stack.at(-1)!.text as { text: string }[]) : []);
const textOf = (n: Node) => runsOf(n).map((r) => r.text).join("");
const header = (def: TDocumentDefinitions, page: number, pages = 9) => (def.header as (p: number, n: number, s: unknown) => Node)(page, pages, {});
const footer = (def: TDocumentDefinitions, page: number, pages = 9) => (def.footer as (p: number, n: number) => Node)(page, pages);

describe("a report document as pdfmake draws it", () => {
  it("maps page size, margins, colours, links, breaks and the grid without rendering", () => {
    const def = docDefinitionOf(doc({ page: "legal-landscape" }));
    expect([def.pageSize, def.pageOrientation, def.pageMargins, def.defaultStyle]).toEqual(["LEGAL", "landscape", [18, 57, 18, 14.5], { font: "BCSans", fontSize: 10 }]);
    expect(def.content).toHaveLength(3);
    expect(def.content).toMatchObject([{ fontSize: 14 }, { pageBreak: "before" }, { table: { headerRows: 1, keepWithHeaderRows: 1, dontBreakRows: true } }]);
    const t = tablesOf(def)[0]!;
    // A legacy width is the whole cell: pdfmake's leaves out the 2 x 2 pt padding and the 1 pt line.
    expect(t.table!.widths).toEqual([55, "*", 55]);
    const body = t.table!.body;
    expect(body[0]![0]!.fillColor).toBe("#558abd");
    expect(body[1]![1]!.fillColor).toBe("#ccc0d9");
    expect((body[1]![2]!.text as { link?: string }[])[0]!.link).toBe("https://staff.example.test/hub/calendar/activities/20001");
    const layout = t.layout as { hLineColor: (i: number) => string; hLineWidth: (i: number) => number; paddingTop: (i: number) => number };
    expect([layout.hLineColor(0), layout.hLineWidth(0), layout.paddingTop(1)]).toEqual(["#d3d3d3", 1, 2]);
  });

  it("a table's titles are header rows, repeated with it and drawn without lines or padding; a bookmark rides on the first row, once", () => {
    const def = docDefinitionOf(doc({ blocks: [{ ...table(2), titles: [{ runs: [{ text: "Sample day" }], size: 16, align: "center" }, { runs: [{ text: "Sample section" }], size: 14, bookmark: "Sample bookmark" }] }] }));
    const t = tablesOf(def)[0]!;
    expect(t.table!.headerRows).toBe(3);
    expect(t.table!.body[0]![0]).toMatchObject({ fontSize: 16, alignment: "center", colSpan: 3, border: [false, false, false, false] });
    expect(t.table!.body[1]![0]).not.toHaveProperty("outline");
    expect(t.table!.body[3]![0]!.stack![0]).toMatchObject({ outline: true, outlineText: "Sample bookmark" });
    const layout = t.layout as { hLineWidth: (i: number) => number; paddingTop: (i: number) => number };
    expect([0, 1, 2].map(layout.hLineWidth)).toEqual([0, 0, 1]);
    expect([0, 1, 2].map(layout.paddingTop)).toEqual([0, 0, 2]);
  });

  it("a CC ID# may break after its hyphen, never inside the number", () => {
    const def = docDefinitionOf(doc({ blocks: [{ kind: "heading", runs: [{ text: "HLTH-20001", wrapAtHyphen: true }, { text: "a-1" }], size: 10 }] }));
    expect(runsOf(nodes(def)[0]!).map((r) => r.text)).toEqual(["HLTH-​20001", "a-1"]);
  });

  it("renders: Letter portrait, page 1's own header and no footer, later pages' running text, Page X of Y, BC Sans embedded, the table header repeated", async () => {
    useBcSans(fontsDir, imagesDir);
    const bytes = await renderPdf(doc());
    const pages = await pdfPages(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((p) => p.size[0] === 612 && p.size[1] === 792)).toBe(true);
    const text = pages.map((p) => p.lines.map((l) => l.text).join("\n"));
    expect(text[0]).toContain("Sample first page header");
    expect(text[0]).not.toContain("Page 1 of");
    expect(text[0]).not.toContain("DRAFT AND CONFIDENTIAL");
    for (let i = 1; i < pages.length; i++) {
      expect(text[i]).toContain(`Page ${i + 1} of ${pages.length}`);
      expect(text[i]).toContain("DRAFT AND CONFIDENTIAL");
      expect(text[i]).toContain("Updated sample");
      expect(text[i]).toMatch(/Date Activity\/Details CC ID#/);
    }
    expect(text[1]).toContain("Sample second page");
    expect(pages[1]!.links[0]!.url).toBe("https://staff.example.test/hub/calendar/activities/20001");
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toMatch(/\+BCSans-Regular/);
    expect(raw).toMatch(/\+BCSans-Bold/);
    expect(raw).not.toMatch(/Helvetica/);
  });

  it("renders Legal landscape", async () => {
    useBcSans(fontsDir, imagesDir);
    const pages = await pdfPages(await renderPdf(doc({ page: "legal-landscape", firstPage: undefined, blocks: [table(3)] })));
    expect(pages[0]!.size).toEqual([1008, 612]);
    expect(pages[0]!.lines.map((l) => l.text).join("\n")).toContain("Page 1 of 1");
  });

  it("an image is read only from the images folder, by a bare file name", async () => {
    useBcSans(fontsDir, imagesDir);
    const named = (name: string) => doc({ header: { ...doc().header!, image: { name, width: 10, height: 10 } } });
    await expect(renderPdf(named("../package.json"))).rejects.toThrow("not an image name");
    await expect(renderPdf(named("Sample-missing.jpg"))).rejects.toThrow();
  });
});

// The four reports as pdfmake would draw them, BC's pictures on: legacy's values, read from the definition.
const NOW = new Date("2026-11-03T18:00:00Z");
const q = (filter: object) => listQuerySchema.parse({ filter });
const RULES = { ...TEST_RULES, lookAheadCoverImage: "LookAheadCover.jpg", lookAheadLogoImage: "ProvinceOfBritishColumbia.jpg" };
const row = (id: number, over: Partial<ReportRow>) => reportRow({ id, title: `Sample ${id}`, ...over });
const ROWS = [
  row(20001, { hqSection: "events_and_speeches", isIssue: true, startAt: bc("2026-11-10", "09:00"), endAt: bc("2026-11-10", "10:00") }),
  row(20002, { hqSection: "events_and_speeches", startAt: bc("2026-11-10", "11:00"), endAt: bc("2026-11-10", "12:00") }),
  row(20003, { hqSection: "issues_and_reports", isIssue: true, startAt: bc("2026-11-10", "13:00"), endAt: bc("2026-11-10", "14:00") }),
  row(20004, { hqSection: "issues_and_reports", startAt: bc("2026-11-10", "15:00"), endAt: bc("2026-11-10", "16:00") }),
  row(20005, { hqSection: "in_the_news", isIssue: true, isConfirmed: false, startAt: bc("2026-11-11", "09:00"), endAt: bc("2026-11-11", "10:00") }),
  row(20006, { hqSection: "events_and_speeches", longTermOutlook: true, startAt: bc("2027-02-01", "09:00"), endAt: bc("2027-02-01", "10:00") }),
  row(20007, { hqSection: "events_and_speeches", longTermOutlook: true, startAt: bc("2027-02-02", "09:00"), endAt: bc("2027-02-02", "10:00") }),
];
const lookAhead = (detailed: boolean) =>
  docDefinitionOf(lookAheadDoc({ rules: RULES, isHq: true, now: NOW, today: "2026-11-03", origin: null, consultationsKeys: [], rows: ROWS, q: q({ from: "2026-11-10" }) }, { detailed }));
const listCtx = { rules: RULES, isHq: true, now: NOW, today: "2026-11-03", origin: null, rows: ROWS.slice(0, 5), q: q({ from: "2026-11-01" }) };
/** The table whose first title row says `title`. */
const titled = (def: TDocumentDefinitions, title: string) => tablesOf(def).find((t) => (t.table!.body[0]![0]!.text as { text: string }[] | undefined)?.[0]?.text === title)!;
const eventsOf = (def: TDocumentDefinitions) => titled(def, "Tuesday, November 10, 2026");

describe("the Look Ahead as pdfmake draws it: legacy's values (LookAheadReport.rdlc and its subreports)", () => {
  const def = lookAhead(false);

  it("Letter, 0.25 in sides, 0.2 in + 1.5 cm top, a 0.51 cm footer; 10 pt body; LookAheadReport as the PDF title", () => {
    expect(def.pageMargins).toEqual([18, 14.4 + 72 * 1.5 / 2.54, 18, 72 * 0.51181 / 2.54]);
    expect(def.defaultStyle).toEqual({ font: "BCSans", fontSize: 10 });
    expect(def.info).toEqual({ title: "LookAheadReport" });
    expect(imagesOf(lookAheadDoc({ rules: RULES, isHq: true, now: NOW, today: "2026-11-03", origin: null, consultationsKeys: [], rows: [], q: q({ from: "2026-11-10" }) }, { detailed: false })))
      .toEqual(["ProvinceOfBritishColumbia.jpg", "LookAheadCover.jpg"]);
    expect(def.images).toEqual({ "LookAheadCover.jpg": "LookAheadCover.jpg", "ProvinceOfBritishColumbia.jpg": "ProvinceOfBritishColumbia.jpg" });
  });

  it("the cover: the picture at 96 ppi under the header, no drawn banner; the legend at 7 in, 0.5 in, legacy's rows, Consultations and Dialogues included", () => {
    const [picture, legend] = nodes(def);
    expect(picture).toMatchObject({ image: "LookAheadCover.jpg", width: 573.75, height: 742.5, absolutePosition: { x: 18, y: def.pageMargins![1 as never] } });
    expect(nodes(def).some((n) => n.table && JSON.stringify(n).includes("#595959"))).toBe(false);
    const top = (def.pageMargins as number[])[1]!;
    expect(legend!.absolutePosition).toEqual({ x: 54, y: top + 504 });
    const body = legend!.table!.body;
    expect(body[0]![0]!.stack![0]).toMatchObject({ fontSize: 14, text: [{ bold: true }] });
    expect(body[1]![0]).toMatchObject({ text: [{ text: "Contents:", color: "#808080" }], fontSize: 14 });
    const items = body.slice(2);
    expect(items.map((r) => (r[1]!.text as { text: string }[])[0]!.text)).toEqual([
      "Events, Speeches and Releases", "Issues and Reports", "Consultations and Dialogues", "In the News", "Awareness Dates", "Long Term Outlook",
    ]);
    expect(items.map((r) => (r[0]!.canvas as { color: string }[])[0]!.color)).toEqual(["#558abd", "#ccc0d9", "#daeef3", "#e8f3a9", "#eaf1dd", "#edf2f8"]);
    // 0.39 x 0.31 in cells, the swatch inside a 0.3 cm white border; the name 12 pt, 10 pt in and 5 pt down.
    expect(legend!.table!.widths).toEqual([expect.closeTo(28.35, 2), expect.closeTo(425.2, 2)]);
    expect(items[0]![0]).toMatchObject({ canvas: [{ w: expect.closeTo(19.84, 1), h: expect.closeTo(14.17, 1) }], margin: [expect.closeTo(4.25, 1), expect.closeTo(4.25, 1), 0, 0] });
    expect(items[0]![1]).toMatchObject({ fontSize: 12, margin: [10, 5, 0, 0] });
  });

  it("page 1: DRAFT ONLY, 11 pt black, right; later pages: the logo at the left and DRAFT AND CONFIDENTIAL 11 pt Brown, right", () => {
    const first = header(def, 1);
    expect(first.columns![0]).toMatchObject({ text: "" });
    expect(first.columns![1]).toMatchObject({ alignment: "right", text: [{ text: "DRAFT ONLY - NOT FOR CIRCULATION\nInformation is confidential and subject to change" }] });
    expect(first).toMatchObject({ fontSize: 11, margin: [18, 14.4, 18, 0] });
    expect(footer(def, 1)).toBe("");
    const later = header(def, 2);
    expect(later.columns![0]).toMatchObject({ image: "ProvinceOfBritishColumbia.jpg", width: 114.75, height: 30.75 });
    expect(later.columns![1]).toMatchObject({ alignment: "right", text: [{ text: "DRAFT AND CONFIDENTIAL", color: "#a52a2a" }] });
    expect(later.fontSize).toBe(11);
  });

  it("the footer: Updated at the left; the CHANGED note, three spaces and Page X of Y in one right-aligned run; all 9 pt", () => {
    const f = footer(def, 2, 7);
    expect(f.fontSize).toBe(9);
    expect(textOf(f.columns![0]!)).toBe("Updated Tuesday, Nov 3, 2026 11:00 AM");
    expect(f.columns![1]!.alignment).toBe("right");
    expect(textOf(f.columns![1]!)).toBe('"CHANGED" applies to major detail or date changes only (not time switches)   Page 2 of 7');
  });

  it("headings: Inside and Outside Government 16 pt bold underlined black; the day 16 pt navy centred; sections 14 pt navy; bookmarks as legacy's", () => {
    const inside = nodes(def).find((n) => (n.text as { text: string }[] | undefined)?.[0]?.text === "Inside Government")!;
    expect(inside).toMatchObject({ fontSize: 16, outline: true, outlineText: "Events, Speeches and Releases", text: [{ bold: true, decoration: "underline" }] });
    expect((inside.text as { color?: string }[])[0]).not.toHaveProperty("color");
    const events = eventsOf(def).table!.body;
    expect(events[0]![0]).toMatchObject({ fontSize: 16, alignment: "center", text: [{ text: "Tuesday, November 10, 2026", bold: true, color: "#384c70" }] });
    expect(events[1]![0]).toMatchObject({ fontSize: 14, text: [{ text: "Events, Speeches & Releases", bold: true, color: "#384c70" }] });
    const outlines = JSON.stringify(def.content).match(/"outlineText":"[^"]+"/g);
    // No Awareness Dates here: these rows have none.
    expect(outlines).toEqual(["Events, Speeches and Releases", "Issues and Reports", "In the News", "Long Term Outlook"].map((t) => `"outlineText":"${t}"`));
  });

  it("Events: 11 pt white headers, Lead, RLS and CC ID# centred, legacy's widths, #d3d3d3 zebra, CC ID# #0000ff, Activity/Details 8 pt under", () => {
    const t = eventsOf(def);
    const head = t.table!.body[2]!;
    expect(head.map((c) => c.alignment ?? "left")).toEqual(["left", "center", "left", "center", "center"]);
    expect(head.every((c) => c.fillColor === "#558abd" && (c.text as { size?: number; fontSize?: number; color: string }[])[0]!.color === "#ffffff")).toBe(true);
    expect(head.map((c) => (c.text as { fontSize?: number }[])[0]!.fontSize)).toEqual([11, 11, 11, 11, 11]);
    // 1 in, 0.66 in, 4.87 in, 0.8 in, 0.66 in, less 5 pt each for padding and line.
    expect(t.table!.widths.map((w) => Math.round((w as number) * 10) / 10)).toEqual([67, 42.4, 345.5, 52.6, 42.4]);
    const [first, second] = t.table!.body.slice(3);
    expect(first![1]!.fillColor).toBe("#d3d3d3");
    expect(second![1]!.fillColor).toBeUndefined();
    expect(first![2]!.margin).toEqual([0, 0, 0, 6]);
    expect((first![4]!.text as { color: string; text: string }[])[0]).toMatchObject({ color: "#0000ff", text: "HLTH-​20001" });
  });

  it("Events: the plain Look Ahead paints no issue purple; the Exec only on Activity/Details, Lead, RLS and CC ID# keeping the zebra", () => {
    const plainRow = eventsOf(def).table!.body[3]!;
    expect(plainRow.map((c) => c.fillColor)).toEqual(["#558abd", "#d3d3d3", "#d3d3d3", "#d3d3d3", "#d3d3d3"]);
    const exec = eventsOf(lookAhead(true)).table!.body[3]!;
    expect(exec.map((c) => c.fillColor)).toEqual(["#558abd", "#d3d3d3", "#ccc0d9", "#d3d3d3", "#d3d3d3"]);
  });

  it("Issues and Reports: purple Activity/Details only on an issue's row, Category only on Issue, CC ID# and Rls never; headers centred as legacy's", () => {
    const t = titled(def, "ISSUES AND REPORTS")!;
    expect(t.table!.headerRows).toBe(2);
    expect(t.table!.body[1]!.map((c) => c.alignment ?? "left")).toEqual(["left", "center", "left", "center", "center"]);
    const [issue, other] = t.table!.body.slice(2);
    expect(issue!.map((c) => c.fillColor)).toEqual(["#f2dbdb", undefined, "#ccc0d9", "#ccc0d9", undefined]);
    expect(other!.map((c) => c.fillColor)).toEqual(["#f2dbdb", undefined, undefined, undefined, undefined]);
    expect(t.table!.widths.map((w) => Math.round((w as number) * 10) / 10)).toEqual([67, 42.4, 347.8, 52.6, 38.2]);
  });

  it("In the News: CC ID# and Rls never filled, an issue's Activity/Details and Category purple, TBC bold #1919d2", () => {
    const t = titled(def, "In the News")!;
    const r = t.table!.body[2]!;
    expect(r.map((c) => c.fillColor)).toEqual(["#e8f3a9", undefined, "#ccc0d9", "#ccc0d9", undefined]);
    expect((r[0]!.stack ? r[0]!.stack.at(-1)!.text : r[0]!.text) as { text: string; bold?: boolean; color?: string }[]).toContainEqual({ text: " TBC", bold: true, color: "#1919d2" });
  });

  it("the Long Term Outlook: #9e3a38 header; the even rows #edf2f8 across the row, the odd ones bare", () => {
    const outlookHeading = nodes(def).findIndex((n) => (n.text as { text: string }[] | undefined)?.[0]?.text === "LONG TERM OUTLOOK");
    const t = nodes(def)[outlookHeading + 1]!;
    expect(t.table!.body[0]!.every((c) => c.fillColor === "#9e3a38")).toBe(true);
    expect(t.table!.body.slice(1).map((r) => r.map((c) => c.fillColor ?? null))).toEqual([[null, null, null], ["#edf2f8", "#edf2f8", "#edf2f8"]]);
    expect(t.table!.widths.map((w) => Math.round((w as number) * 10) / 10)).toEqual([67, 425.9, 67]);
  });

  it("the Exec's Last updated: 9 pt #cf7a50", () => {
    const runs = JSON.stringify(lookAhead(true).content);
    expect(runs).toMatch(/"text":"Last updated [^"]+","fontSize":9|"text":"Last updated [^"]+","color":"#cf7a50","fontSize":9/);
  });
});

describe("the 30/60/90 and Planning as pdfmake draws them: legacy's values", () => {
  it("30/60/90: 0.25 in sides, 0.5 in top, no header; 10 pt white headers on teal, DATE and ID/CONT centred; ID/CONT centred and never filled; TBC bold #1919d2", () => {
    const def = docDefinitionOf(thirtySixtyNinetyDoc(listCtx));
    expect(def.pageMargins).toEqual([18, 36, 18, 72 * 0.51181 / 2.54]);
    expect(def.info).toEqual({ title: "Main30_60_90Report" });
    expect(header(def, 1)).toBe("");
    const t = tablesOf(def)[0]!;
    const head = t.table!.body[0]!;
    expect(head.map((c) => c.alignment ?? "left")).toEqual(["center", "left", "left", "center"]);
    expect(head.every((c) => c.fillColor === "#35989d" && !(c.text as { fontSize?: number }[])[0]!.fontSize)).toBe(true);
    const issue = t.table!.body[1]!;
    expect(issue.map((c) => c.fillColor ?? null)).toEqual(["#35989d", "#ccc0d9", "#ccc0d9", null]);
    expect(issue[3]!.alignment).toBe("center");
    const tbc = t.table!.body.find((r) => (r[0]!.text as { text: string }[]).some((x) => x.text.includes("TBC")))!;
    expect((tbc[0]!.text as object[]).at(-1)).toEqual({ text: " TBC", bold: true, color: "#1919d2" });
    const f = footer(def, 1, 3);
    expect(f.fontSize).toBe(9);
    expect(f.columns![0]!.text).toEqual([{ text: "DRAFT AND CONFIDENTIAL  ", color: "#a52a2a" }, { text: "Updated Tuesday, Nov 3, 2026 11:00 AM" }]);
    expect(textOf(f.columns![1]!)).toBe("Page 1 of 3");
  });

  it("Planning: Legal, 0.5 in sides, 0.25 in top and bottom; 11 pt headers on navy in #4e648a lines, CC ID# right-aligned, header and cells; 0.5 pt black body lines; TBC bold #1919d2", () => {
    const def = docDefinitionOf(planningDoc(listCtx));
    expect(def.pageMargins).toEqual([36, 18 + 72 * 0.67 / 2.54, 36, 18 + 72 * 0.51181 / 2.54]);
    expect(def.info).toEqual({ title: "PlanningReport" });
    const h = header(def, 1);
    expect(h.columns![0]!.text).toEqual([{ text: "Sample Corporate Calendar: Schedule of Activities", bold: true, color: "#384c70", fontSize: 14 }]);
    expect(h.columns![1]).toMatchObject({ alignment: "right", text: [{ text: "DRAFT AND CONFIDENTIAL", color: "#a52a2a" }] });
    expect(h.fontSize).toBe(11);
    const t = tablesOf(def)[0]!;
    const head = t.table!.body[0]!;
    expect(head.map((c) => c.alignment ?? "left")).toEqual(["left", "left", "left", "right"]);
    expect(head.every((c) => c.fillColor === "#384c70" && (c.text as { fontSize: number }[])[0]!.fontSize === 11)).toBe(true);
    expect(head[0]!.borderColor).toEqual(["#4e648a", "#4e648a", "#4e648a", "#4e648a"]);
    expect(t.table!.body[1]![3]!.alignment).toBe("right");
    const layout = t.layout as { hLineColor: (i: number) => string; hLineWidth: (i: number) => number };
    expect([layout.hLineColor(0), layout.hLineColor(2), layout.hLineWidth(2)]).toEqual(["#4e648a", "#000000", 0.5]);
    const tbc = t.table!.body.find((r) => (r[0]!.text as { text: string }[]).some((x) => x.text.includes("TBC")))!;
    expect((tbc[0]!.text as object[])[1]).toEqual({ text: " TBC", bold: true, color: "#1919d2" });
    expect(textOf(footer(def, 1, 2).columns![1]!)).toBe("Page 1 of 2");
    expect(footer(def, 1, 2).fontSize).toBe(9);
  });
});

describe("the pictures, rendered", () => {
  it("the Look Ahead embeds the cover on page 1 and the logo on every later page, and none in the other reports", async () => {
    useBcSans(fontsDir, imagesDir);
    const bytes = await renderPdf(lookAheadDoc({ rules: RULES, isHq: true, now: NOW, today: "2026-11-03", origin: null, consultationsKeys: [], rows: ROWS, q: q({ from: "2026-11-10", to: "2026-11-11" }) }, { detailed: false }));
    const raw = Buffer.from(bytes).toString("latin1");
    // Two images, each embedded once and drawn wherever it appears.
    expect(raw.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(raw).toMatch(/\/Width 765\s*\/Height 990|\/Height 990\s*\/Width 765|\/Width 765/);
    const pages = await pdfPages(bytes);
    expect(pages[0]!.lines.map((l) => l.text)).toContain("Contents:");
    expect(COLOURS.consultations).toBe("#daeef3");
    const planning = Buffer.from(await renderPdf(planningDoc(listCtx))).toString("latin1");
    expect(planning).not.toMatch(/\/Subtype \/Image/);
  });
});
