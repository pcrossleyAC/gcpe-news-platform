// Renders one report through the report jobs and the worker renderer, with the report routes
// loaded as a request would load them, and prints, as JSON, every module this (main) thread loaded
// and the size of the PDF. Run with `--import tsx`.
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
const { ReportJobs } = await import("../../src/reports/jobs.ts");
await import("../../src/http/report-routes.ts");
const jobs = new ReportJobs({ renderer: workerRenderer({ ...reportAssets(), heapMb: 256, timeoutMs: 60_000 }), concurrency: 1 });
const owner = "00000000-0000-4000-8000-000000000401";
const started = jobs.start(owner, "look-ahead", {
  page: "letter-portrait",
  title: "Sample report",
  header: null,
  footer: { pageNumbers: true },
  blocks: [{ kind: "heading", runs: [{ text: "Sample heading" }], size: 14 }],
});
const view = await jobs.settle(owner, started.id, 60_000);
const bytes = view.status === "ready" ? jobs.pdf(owner, started.id).bytes : new Uint8Array();
await jobs.close();
process.stdout.write(JSON.stringify({ pdfBytes: bytes.length, loaded }));
