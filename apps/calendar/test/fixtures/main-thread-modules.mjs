// Renders one report through the worker renderer and prints, as JSON, every module this (main)
// thread loaded and the size of the PDF. Run with `--import tsx`.
import { registerHooks } from "node:module";

const loaded = [];
registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});
const { reportAssets } = await import("../../src/reports/render/assets.ts");
const { workerRenderer } = await import("../../src/reports/render/renderer.ts");
const renderer = workerRenderer({ ...reportAssets(), heapMb: 256, timeoutMs: 60_000 });
const bytes = await renderer.render({
  page: "letter-portrait",
  title: "Sample report",
  header: null,
  footer: { pageNumbers: true },
  blocks: [{ kind: "heading", runs: [{ text: "Sample heading" }], size: 14 }],
});
await renderer.close();
process.stdout.write(JSON.stringify({ pdfBytes: bytes.length, loaded }));
