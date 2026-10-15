// The report parity runner on the fictional CSV fixture: real legacy files never enter the repo.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { legacyCsvFiles, partCFile } from "../apps/calendar/test/legacy-csv-fixture";
import { outlineOf, pdfPages } from "../apps/calendar/test/pdf-text";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { renderPdf, useBcSans } from "../apps/calendar/src/reports/render/pdf";
import { parsePdfDate, parseParityArgs, REPORTS, runParity, type ParityOptions } from "../scripts/calendar-report-parity";

const BC = resolve(import.meta.dirname, "..", "config", "tenants", "bc.json");
let dir: string;
let options: (over: Partial<ParityOptions>) => ParityOptions;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "report-parity-"));
  const csv = legacyCsvFiles().map((f) => { const p = join(dir, f.name); writeFileSync(p, f.bytes); return p; });
  writeFileSync(join(dir, "part-c.csv"), partCFile().bytes);
  mkdirSync(join(dir, "legacy-empty"));
  useBcSans(reportAssets().fontsDir);
  const empty = await renderPdf({ page: "letter-portrait", title: "Sample", header: null, footer: { pageNumbers: true }, blocks: [{ kind: "heading", runs: [{ text: "Sample" }], size: 12 }] });
  for (const r of REPORTS) writeFileSync(join(dir, "legacy-empty", r.legacy), empty);
  options = (over) => ({
    csv, partC: join(dir, "part-c.csv"), legacyDir: join(dir, "legacy-empty"), out: join(dir, "out"),
    cutoff: "2031-03-01", from: "2031-03-03", to: "2031-03-05", to90: "2031-05-31",
    now: new Date("2031-03-06T17:00:00Z"), keepDbs: false, tenantConfig: BC, ...over,
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the report parity runner (spec addendum §12.3)", () => {
  it("reads its arguments, and refuses a range that starts before the cutoff", () => {
    const base = ["--csv", "a.csv", "--csv", "b.csv", "--legacy-dir", "l", "--out", "/tmp/o", "--cutoff", "2031-03-01", "--from", "2031-03-03", "--to", "2031-03-05", "--to-30-60-90", "2031-05-31"];
    expect(parseParityArgs(base)).toMatchObject({ csv: ["a.csv", "b.csv"], partC: null, now: null, keepDbs: false });
    expect(parseParityArgs([...base, "--part-c", "c.csv", "--now", "2031-03-06T17:00:00Z", "--keep-dbs"])).toMatchObject({ partC: "c.csv", keepDbs: true, now: new Date("2031-03-06T17:00:00Z") });
    expect(() => parseParityArgs(base.map((a) => (a === "2031-03-03" ? "2031-02-27" : a)))).toThrow(/--from must be on or after --cutoff/);
    expect(() => parseParityArgs(base.filter((a) => a !== "--csv" && a !== "a.csv" && a !== "b.csv"))).toThrow(/--csv/);
    expect(() => parseParityArgs([...base, "--confirm"])).toThrow(/Unknown argument/);
  });

  it("reads a PDF creation date as SSRS writes it", () => {
    expect(parsePdfDate("D:20310303081240-07'00'")).toEqual(new Date("2031-03-03T15:12:40Z"));
    expect(parsePdfDate("D:20310303081240Z")).toEqual(new Date("2031-03-03T08:12:40Z"));
    expect(parsePdfDate("yesterday")).toBeNull();
  });

  it("refuses an --out inside the repository before it reads or creates anything", async () => {
    await expect(runParity(options({ out: resolve(import.meta.dirname, "..", "docs", "parity-out") }))).rejects.toThrow(/outside the repository/);
  });

  it("imports the snapshot, renders our four reports, compares each with legacy's, and writes only under --out", async () => {
    const log: string[] = [];
    const first = await runParity({ ...options({}), log: (s) => log.push(s) });
    expect(first.activities).toBe(5);
    expect(first.reports.map((r) => r.kind)).toEqual(["look-ahead", "exec-look-ahead", "planning", "30-60-90"]);
    expect(first.reports.every((r) => !r.same)).toBe(true);
    const out = join(dir, "out");
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(readdirSync(out).sort()).toEqual(["compare", "import-report.json", "import-report.txt", "ours", "store", "summary.json"]);
    expect(readFileSync(join(out, "import-report.txt"), "utf8")).toContain("Not provided: favourites");
    const la = outlineOf(await pdfPages(new Uint8Array(readFileSync(join(out, "ours", "LookAhead.pdf")))));
    expect(la).toContain("id:41001");
    expect(la).not.toContain("id:41003");
    expect(log.at(-1)).toBe("Dropped the throwaway databases.");

    const same = join(dir, "legacy-ours");
    mkdirSync(same);
    for (const r of REPORTS) copyFileSync(join(out, "ours", r.legacy), join(same, r.legacy));
    const second = await runParity(options({ legacyDir: same, out: join(dir, "out-2") }));
    expect(second.reports.map((r) => [r.kind, r.same, r.outlineChanges, r.rows.differ])).toEqual(REPORTS.map((r) => [r.kind, true, 0, 0]));
  }, 180_000);

  it("a failed run still drops its databases", async () => {
    const log: string[] = [];
    await expect(runParity({ ...options({ legacyDir: join(dir, "missing"), out: join(dir, "out-3"), now: null }), log: (s) => log.push(s) })).rejects.toThrow();
    expect(log.at(-1)).toBe("Dropped the throwaway databases.");
  }, 120_000);
});
