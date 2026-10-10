import { Worker } from "node:worker_threads";
import type { ReportDoc } from "../model";
import type { ReportAssets } from "./assets";

/**
 * The rendering seam (spec addendum §10.1, Q57): pdfmake in a worker on SiteGround, where Chromium
 * can't run. A browser renderer on a container host would implement the same interface over the
 * same ReportDoc.
 */
export interface PdfRenderer {
  render(doc: ReportDoc): Promise<Uint8Array>;
  /** Ends every render still running. */
  close(): Promise<void>;
}

export type RenderFailure = "out_of_memory" | "timeout" | "failed";
export class ReportRenderError extends Error {
  override name = "ReportRenderError";
  /** What safeErrorLabel logs when there is no cause with a code of its own. */
  readonly code: string;
  constructor(
    readonly reason: RenderFailure,
    options?: ErrorOptions,
  ) {
    super(`the report render ended: ${reason}`, options);
    this.code = `ERR_REPORT_${reason.toUpperCase()}`;
  }
}

export interface WorkerRendererOptions extends ReportAssets {
  /** The worker's old-generation heap, in MB: a render past it ends, never the process. */
  heapMb: number;
  timeoutMs: number;
}

const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

/** Each render in a fresh worker thread, so pdfmake's synchronous layout never blocks the stack's event loop. */
export function workerRenderer(o: WorkerRendererOptions): PdfRenderer {
  const live = new Set<Worker>();
  return {
    render(doc) {
      return new Promise<Uint8Array>((resolve, reject) => {
        const worker = new Worker(o.workerFile, {
          execArgv: o.execArgv,
          workerData: { fontsDir: o.fontsDir },
          // Not the stack's environment: the worker needs none of it, and it holds the secrets.
          env: {},
          resourceLimits: { maxOldGenerationSizeMb: o.heapMb, maxYoungGenerationSizeMb: 32 },
          // Anything the worker prints may quote the report, so it never reaches the stack's log.
          stdout: true,
          stderr: true,
        });
        worker.stdout.resume();
        worker.stderr.resume();
        live.add(worker);
        let settled = false;
        const settle = (f: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          live.delete(worker);
          void worker.terminate();
          f();
        };
        const timer = setTimeout(() => settle(() => reject(new ReportRenderError("timeout"))), o.timeoutMs);
        worker.once("message", (bytes: Uint8Array) => settle(() => resolve(bytes)));
        worker.once("error", (e) => settle(() => reject(new ReportRenderError(codeOf(e) === "ERR_WORKER_OUT_OF_MEMORY" ? "out_of_memory" : "failed", { cause: e }))));
        worker.once("exit", () => settle(() => reject(new ReportRenderError("failed"))));
        worker.postMessage(doc);
      });
    },
    async close() {
      await Promise.all([...live].map((w) => w.terminate()));
    },
  };
}
