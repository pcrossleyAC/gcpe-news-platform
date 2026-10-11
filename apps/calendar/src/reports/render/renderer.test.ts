import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pdfPages } from "../../../test/pdf-text";
import type { ReportDoc } from "../model";
import { BUNDLED_WORKER, reportAssets } from "./assets";
import { ReportRenderError, workerRenderer, type PdfRenderer } from "./renderer";

const doc = (rows: number): ReportDoc => ({
  page: "letter-portrait",
  title: "Sample report",
  header: null,
  footer: { pageNumbers: true },
  blocks: [
    {
      kind: "table",
      widths: [60, "*", 60],
      header: ["Date", "Activity/Details", "CC ID#"].map((text) => ({ runs: [{ text }] })),
      rows: Array.from({ length: rows }, (_, i) => [{ runs: [{ text: "Tue Nov 10" }] }, { runs: [{ text: `Sample row ${i}: ${"fictional details ".repeat(8)}` }] }, { runs: [{ text: `HLTH-${20001 + i}` }] }]),
    },
  ],
});

describe("rendering in a worker thread (the stack's event loop stays free)", () => {
  let renderer: PdfRenderer | null = null;
  afterEach(async () => {
    await renderer?.close();
    renderer = null;
  });
  const make = (over: { heapMb?: number; timeoutMs?: number } = {}) => (renderer = workerRenderer({ ...reportAssets(), heapMb: 256, timeoutMs: 60_000, ...over }));

  it("finds the worker and BC Sans in a source checkout, and beside a bundle when they're there", () => {
    const src = reportAssets();
    expect(src.workerFile).toMatch(/reports\/render\/worker\.ts$/);
    expect(src.execArgv).toEqual(["--import", "tsx"]);
    expect(src.fontsDir).toMatch(/@bcgov\/bc-sans\/fonts$/);
    const bundle = reportAssets("file:///srv/app/stack.js", (p) => p === `/srv/app/${BUNDLED_WORKER}` || p === "/srv/app/fonts/");
    expect(bundle).toEqual({ workerFile: `/srv/app/${BUNDLED_WORKER}`, execArgv: [], fontsDir: "/srv/app/fonts/" });
  });

  it("renders a report while the main thread keeps running", async () => {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const bytes = await make().render(doc(600));
    delay.disable();
    const pages = await pdfPages(bytes);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pages.at(-1)!.lines.map((l) => l.text).join("\n")).toContain(`Page ${pages.length} of ${pages.length}`);
    // The work happened off this thread: the main thread's event loop was never held up for long.
    expect(delay.max / 1e6).toBeLessThan(200);
  });

  it("a render past its heap ends the worker, not the process: out_of_memory", async () => {
    const err = await make({ heapMb: 24 }).render(doc(20_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportRenderError);
    expect((err as ReportRenderError).reason).toBe("out_of_memory");
  });

  it("a render past its time ends: timeout", async () => {
    const err = await make({ timeoutMs: 1 }).render(doc(10)).catch((e: unknown) => e);
    expect((err as ReportRenderError).reason).toBe("timeout");
  });

  it("closing ends the renders still running", async () => {
    const r = make();
    const pending = r.render(doc(3000)).catch((e: unknown) => e);
    await r.close();
    expect((await pending as ReportRenderError).reason).toBe("failed");
  });
});

describe("what the worker is given, and what leaves it", () => {
  const fixture = (name: string) => fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url));
  const sample: ReportDoc = { ...doc(2), title: "Sample confidential title 7f3a" };

  it("the worker is handed the document and the fonts' folder, nothing else: no environment", async () => {
    process.env.SAMPLE_REPORT_SECRET = "sample-secret-value";
    try {
      const r = workerRenderer({ workerFile: fixture("echo-worker.mjs"), execArgv: [], fontsDir: "/srv/sample/fonts", heapMb: 64, timeoutMs: 10_000 });
      const got = JSON.parse(new TextDecoder().decode(await r.render(sample))) as unknown;
      await r.close();
      expect(got).toEqual({ workerData: { fontsDir: "/srv/sample/fonts" }, messages: [sample], env: {} });
    } finally {
      delete process.env.SAMPLE_REPORT_SECRET;
    }
  });

  it("a render that throws ends as failed, with none of the error's text", async () => {
    const r = workerRenderer({ ...reportAssets(), heapMb: 256, timeoutMs: 60_000 });
    // pdfkit quotes a bad width back in its error: "unsupported number: …Sample 9c1d…".
    const bad = { ...doc(1), blocks: [{ ...doc(1).blocks[0]!, widths: ["Sample 9c1d" as "*", "*", 60] }] } as ReportDoc;
    const err = await r.render(bad).catch((e: unknown) => e);
    await r.close();
    expect(err).toBeInstanceOf(ReportRenderError);
    expect((err as ReportRenderError).reason).toBe("failed");
    expect(inspect(err, { depth: 5 })).not.toContain("9c1d");
  });

  it("nothing the worker prints reaches the process's output", async () => {
    const written: string[] = [];
    const spies = [process.stdout, process.stderr].map((s) =>
      vi.spyOn(s, "write").mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }),
    );
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const r = workerRenderer({ workerFile: fixture("chatty-worker.mjs"), execArgv: [], fontsDir: "/srv/sample/fonts", heapMb: 64, timeoutMs: 10_000 });
      await r.render(sample);
      await r.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      for (const s of [...spies, ...logs]) s.mockRestore();
    }
    expect(written.join("")).not.toContain("7f3a");
    expect(logs.every((l) => l.mock.calls.length === 0)).toBe(true);
  });

  it("the main thread never loads pdfmake: not through the renderer, the report jobs or the report routes", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", fixture("main-thread-modules.mjs")], { encoding: "utf8", timeout: 60_000 });
    const out = JSON.parse(run.stdout) as { pdfBytes: number; loaded: string[] };
    expect(out.pdfBytes).toBeGreaterThan(1000);
    const files = out.loaded.filter((u) => u.startsWith("file:"));
    const ours = files.map((u) => u.replace(/^.*\/apps\/calendar\//, ""));
    expect(ours).toEqual(expect.arrayContaining(["src/reports/render/assets.ts", "src/reports/render/renderer.ts", "src/reports/jobs.ts", "src/http/report-routes.ts"]));
    expect(ours.filter((f) => f.startsWith("src/reports/render/")).sort()).toEqual(["src/reports/render/assets.ts", "src/reports/render/renderer.ts"]);
    expect(files.filter((u) => /pdfmake|pdfkit|fontkit/.test(u))).toEqual([]);
  });
});
