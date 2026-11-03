// The bundled report worker must run where nothing but the artifact exists (SiteGround: no
// node_modules), which an ESM bundle of pdfmake can't (it reads __dirname). This builds it the way
// both build scripts do and renders a page with it.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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

  it("writes report-worker.cjs, BC Sans with its licence and the report images beside it", () => {
    expect(readdirSync(dir).sort()).toEqual(["fonts", "report-images", "report-worker.cjs"]);
    expect(readdirSync(join(dir, "report-images")).sort()).toEqual(["LookAheadCover.jpg", "ProvinceOfBritishColumbia.jpg"]);
    expect(readdirSync(join(dir, "fonts")).sort()).toEqual(["BCSans-Bold.woff", "BCSans-BoldItalic.woff", "BCSans-Italic.woff", "BCSans-Regular.woff", "LICENSE_OFL.txt"]);
    expect(findLeakedPaths(dir, [{ label: "the repository's absolute path", value: resolve(import.meta.dirname, "..") }])).toEqual([]);
  });

  it("is found beside a bundle and renders a PDF in BC Sans, with a report image from beside it", async () => {
    const assets = reportAssets(pathToFileURL(join(dir, "stack.js")).href);
    expect(assets).toEqual({ workerFile: join(dir, "report-worker.cjs"), execArgv: [], fontsDir: `${join(dir, "fonts")}${sep}`, imagesDir: `${join(dir, "report-images")}${sep}` });
    const renderer = workerRenderer({ ...assets, heapMb: 128, timeoutMs: 30_000 });
    try {
      const bytes = await renderer.render({
        page: "letter-portrait", margins: [36, 36, 36, 36], fontSize: 10, title: "Sample",
        header: { image: { name: "ProvinceOfBritishColumbia.jpg", width: 114.75, height: 30.75 }, size: 11, offset: 4 },
        footer: { pageNumbers: true, size: 9, offset: 8 },
        blocks: [{ kind: "heading", runs: [{ text: "Sample bundled render" }], size: 12 }],
      });
      expect((await pdfPages(bytes))[0]!.lines.map((l) => l.text)).toEqual(["Sample bundled render", "Page 1 of 1"]);
      expect(Buffer.from(bytes).toString("latin1")).toMatch(/\+BCSans-Regular/);
      expect(Buffer.from(bytes).toString("latin1")).toMatch(/\/Subtype \/Image/);
    } finally {
      await renderer.close();
    }
  });
});
