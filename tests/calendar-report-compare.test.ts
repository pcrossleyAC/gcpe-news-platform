// The 5i comparison hook, on our own reports only: the past-period legacy PDFs never enter the repo.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { renderPdf, useBcSans } from "../apps/calendar/src/reports/render/pdf";
import type { ReportDoc } from "../apps/calendar/src/reports/model";
import { compareReports, diffOutlines, insideRepo } from "../scripts/calendar-report-compare";

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
    expect((await compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "ours.pdf"), out: join(dir, "same") })).same).toBe(true);
    const r = await compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "other.pdf"), out: join(dir, "differ") });
    expect(r.diff).toEqual(["  § AWARENESS DATES", "- id:1", "  id:2", "+ id:3"]);
    expect(readFileSync(join(dir, "differ", "outline-legacy.txt"), "utf8")).toBe("§ AWARENESS DATES\nid:1\nid:2\n");
    expect(insideRepo(resolve(import.meta.dirname, "..", "docs"))).toBe(true);
    expect(insideRepo(dir)).toBe(false);
    await expect(compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "ours.pdf"), out: resolve(import.meta.dirname, "report-parity") })).rejects.toThrow("--out must be outside the repository");
  });
});
