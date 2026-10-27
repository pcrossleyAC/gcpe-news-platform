// The 5i comparison hook, on our own reports only: the past-period legacy PDFs never enter the repo.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { renderPdf, useBcSans } from "../apps/calendar/src/reports/render/pdf";
import type { ReportDoc } from "../apps/calendar/src/reports/model";
import type { PdfPage } from "../apps/calendar/test/pdf-text";
import { compareReports, compareRowTexts, diffOutlines, insideRepo, rowTextsOf } from "../scripts/calendar-report-compare";

const doc = (ids: number[]): ReportDoc => ({
  page: "letter-portrait", title: "Sample", header: null, footer: { pageNumbers: true },
  blocks: [
    { kind: "heading", runs: [{ text: "AWARENESS DATES" }], size: 12 },
    { kind: "table", widths: ["*", 80], header: [{ runs: [{ text: "Name" }] }, { runs: [{ text: "CC ID#" }] }], rows: ids.map((id) => [{ runs: [{ text: `Sample ${id}` }] }, { runs: [{ text: `HLTH-${id}`, link: `https://staff.example.test/hub/calendar/activities/${id}` }] }]) },
  ],
});

describe("the report comparison hook for 5i (spec addendum §12.3)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "report-compare-"));
    useBcSans(reportAssets().fontsDir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("diffs two outlines line by line", () => {
    expect(diffOutlines(["§ A", "id:1", "id:2"], ["§ A", "id:2", "id:3"])).toEqual(["  § A", "- id:1", "  id:2", "+ id:3"]);
  });

  it("compares two PDFs' sections and activities, writing only outside the repository", async () => {
    writeFileSync(join(dir, "legacy.pdf"), await renderPdf(doc([1, 2])));
    writeFileSync(join(dir, "ours.pdf"), await renderPdf(doc([1, 2])));
    writeFileSync(join(dir, "other.pdf"), await renderPdf(doc([2, 3])));
    const same = await compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "ours.pdf"), out: join(dir, "same") });
    expect(same.same).toBe(true);
    expect(same.rows).toEqual({ same: 2, differ: 0, onlyLegacy: 0, onlyOurs: 0 });
    const r = await compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "other.pdf"), out: join(dir, "differ") });
    expect(r.diff).toEqual(["  § AWARENESS DATES", "- id:1", "  id:2", "+ id:3"]);
    expect(r.rows).toMatchObject({ same: 1, onlyLegacy: 1, onlyOurs: 1 });
    expect(readFileSync(join(dir, "differ", "outline-legacy.txt"), "utf8")).toBe("§ AWARENESS DATES\nid:1\nid:2\n");
    expect(readFileSync(join(dir, "differ", "rows-legacy.txt"), "utf8")).toBe("id:1#1\tSample 1 HLTH-1\nid:2#1\tSample 2 HLTH-2\n");
    // Everything written holds report text: no group or other access, even under a permissive umask.
    // POSIX permission bits only: Windows reports every file as 0o666 and controls access by ACL.
    if (process.platform !== "win32") for (const name of ["", ...readdirSync(join(dir, "differ"))]) expect(statSync(join(dir, "differ", name)).mode & 0o077).toBe(0);
    expect(insideRepo(resolve(import.meta.dirname, "..", "docs"))).toBe(true);
    expect(insideRepo(dir)).toBe(false);
    await expect(compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "ours.pdf"), out: resolve(import.meta.dirname, "report-parity") })).rejects.toThrow("--out must be outside the repository");
  });

  it("refuses a symlink in a temp dir whose real target is inside the repository", async () => {
    const target = resolve(import.meta.dirname, "..", ".tmp-report-compare-symlink-target");
    rmSync(target, { recursive: true, force: true });
    const link = join(dir, "evil-link-to-repo");
    rmSync(link, { force: true });
    symlinkSync(target, link, "dir");
    try {
      expect(insideRepo(link)).toBe(true);
      await expect(compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "ours.pdf"), out: link })).rejects.toThrow("--out must be outside the repository");
    } finally {
      rmSync(link, { force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

const page = (lines: [number, string][], links: [number, number][] = []): PdfPage => ({
  size: [612, 792],
  lines: lines.map(([y, text]) => ({ y, text })),
  links: links.map(([y, id]) => ({ y, url: `https://staff.example.test/hub/calendar/activities/${id}` })),
});

describe("row texts (spec addendum §12.3: the row text with whitespace normalised)", () => {
  it("gives each line to the activity link at or above it, carries a row across a page, and drops furniture, headings and the cover", () => {
    const pages = [
      page([[700, "Contents:"], [600, "Sample cover"]]),
      page([[760, "SAMPLE HEADER"], [700, "Monday, March 3, 2031"], [650, "SAMPLE-1  Sample   one"], [630, "more of one"], [600, "SAMPLE-2 Sample two"], [40, "Printed Sample Page 1 of 3"]], [[652, 1], [602, 2]]),
      page([[760, "SAMPLE HEADER"], [740, "two continues"], [650, "SAMPLE-1 Sample one again"], [40, "Printed Sample Page 2 of 3"]], [[652, 1]]),
      page([[760, "SAMPLE HEADER"], [650, "IN THE NEWS"], [40, "Printed Sample Page 3 of 3"]]),
    ];
    expect(Object.fromEntries(rowTextsOf(pages))).toEqual({
      "id:1#1": "SAMPLE-1 Sample one more of one",
      "id:2#1": "SAMPLE-2 Sample two two continues",
      "id:1#2": "SAMPLE-1 Sample one again",
    });
  });

  it("compares by activity and occurrence, with word-level changes", () => {
    const legacy = new Map([["id:1#1", "Sample one updated 2 days ago"], ["id:2#1", "Sample two"], ["id:3#1", "Sample three"]]);
    const ours = new Map([["id:1#1", "Sample one Last updated 2 days ago"], ["id:2#1", "Sample two"], ["id:4#1", "Sample four"]]);
    const r = compareRowTexts(legacy, ours);
    expect(r.counts).toEqual({ same: 1, differ: 1, onlyLegacy: 1, onlyOurs: 1 });
    expect(r.lines).toEqual([
      "~ id:1#1: + Last",
      "- id:3#1",
      "+ id:4#1",
    ]);
  });
});
