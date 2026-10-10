import { describe, expect, it } from "vitest";
import { pdfPages } from "../../../test/pdf-text";
import type { ReportDoc, TableBlock } from "../model";
import { reportAssets } from "./assets";
import { woffToSfnt } from "./fonts";
import { docDefinitionOf } from "./layout";
import { renderPdf, useBcSans } from "./pdf";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fontsDir = reportAssets().fontsDir;
const table = (rows: number, fill?: string): TableBlock => ({
  kind: "table",
  widths: [60, "*", 60],
  header: ["Date", "Activity/Details", "CC ID#"].map((text) => ({ runs: [{ text, bold: true, color: "#ffffff" }], fill: "#558abd" })),
  rows: Array.from({ length: rows }, (_, i) => [{ runs: [{ text: `Day ${i}` }] }, { runs: [{ text: `Sample row ${i} with fictional details` }], ...(fill ? { fill } : {}) }, { runs: [{ text: `HLTH-${20001 + i}`, link: `https://staff.example.test/hub/calendar/activities/${20001 + i}` }] }]),
});
const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  page: "letter-portrait",
  title: "Sample report",
  firstPage: { header: { right: [{ text: "Sample first page header" }] }, footer: null },
  header: { left: [{ text: "Sample Province" }], right: [{ text: "DRAFT AND CONFIDENTIAL" }] },
  footer: { left: [{ text: "Updated sample" }], pageNumbers: true },
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

describe("a report document as pdfmake draws it", () => {
  it("maps page size, colours, links and breaks without rendering", () => {
    const def = docDefinitionOf(doc({ page: "legal-landscape" }));
    expect([def.pageSize, def.pageOrientation]).toEqual(["LEGAL", "landscape"]);
    expect(def.content).toHaveLength(3);
    expect(def.content).toMatchObject([{ fontSize: 14 }, { pageBreak: "before" }, { table: { headerRows: 1, dontBreakRows: true } }]);
    const body = (def.content as { table?: { body: { fillColor?: string; text: { link?: string }[] }[][] } }[])[2]!.table!.body;
    expect(body[0]![0]!.fillColor).toBe("#558abd");
    expect(body[1]![1]!.fillColor).toBe("#ccc0d9");
    expect(body[1]![2]!.text[0]!.link).toBe("https://staff.example.test/hub/calendar/activities/20001");
  });

  it("renders: Letter portrait, page 1's own header and no footer, later pages' running text, Page X of Y, BC Sans embedded, the table header repeated", async () => {
    useBcSans(fontsDir);
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
    useBcSans(fontsDir);
    const pages = await pdfPages(await renderPdf(doc({ page: "legal-landscape", firstPage: undefined, blocks: [table(3)] })));
    expect(pages[0]!.size).toEqual([1008, 612]);
    expect(pages[0]!.lines.map((l) => l.text).join("\n")).toContain("Page 1 of 1");
  });
});
