// The bundled report worker must run where nothing but the artifact exists (SiteGround: no
// node_modules), which an ESM bundle of pdfmake can't (it reads __dirname). This builds it the way
// both build scripts do and renders a page with it.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReportWorker } from "../scripts/build-report-worker.mjs";
import { findLeakedPaths } from "../scripts/build-siteground.mjs";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { workerRenderer } from "../apps/calendar/src/reports/render/renderer";
import { pdfPages } from "../apps/calendar/test/pdf-text";

describe("the bundled report worker", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "report-worker-"));
    await buildReportWorker(dir);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes report-worker.cjs and BC Sans with its licence beside it", () => {
    expect(readdirSync(dir).sort()).toEqual(["fonts", "report-worker.cjs"]);
    expect(readdirSync(join(dir, "fonts")).sort()).toEqual(["BCSans-Bold.woff", "BCSans-BoldItalic.woff", "BCSans-Italic.woff", "BCSans-Regular.woff", "LICENSE_OFL.txt"]);
    expect(findLeakedPaths(dir, [{ label: "the repository's absolute path", value: resolve(import.meta.dirname, "..") }])).toEqual([]);
  });

  it("is found beside a bundle and renders a PDF in BC Sans", async () => {
    const assets = reportAssets(pathToFileURL(join(dir, "stack.js")).href);
    expect(assets).toEqual({ workerFile: join(dir, "report-worker.cjs"), execArgv: [], fontsDir: `${join(dir, "fonts")}/` });
    const renderer = workerRenderer({ ...assets, heapMb: 128, timeoutMs: 30_000 });
    try {
      const bytes = await renderer.render({ page: "letter-portrait", title: "Sample", header: null, footer: { pageNumbers: true }, blocks: [{ kind: "heading", runs: [{ text: "Sample bundled render" }], size: 12 }] });
      expect((await pdfPages(bytes))[0]!.lines.map((l) => l.text)).toEqual(["Sample bundled render", "Page 1 of 1"]);
      expect(Buffer.from(bytes).toString("latin1")).toMatch(/\+BCSans-Regular/);
    } finally {
      await renderer.close();
    }
  });
});
