import { randomBytes } from "node:crypto";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { ReportJobView, ReportKind } from "@gcpe/calendar-contract";
import type { ReportDoc } from "./model";
import { ReportRenderError, type PdfRenderer } from "./render/renderer";

/** Reports waiting for a render slot, across every user; more is 503 with Retry-After. */
export const REPORT_QUEUE_MAX = 4;
/** Unfinished reports one user may have at once. */
export const REPORT_PER_USER_MAX = 2;
/** A finished report is kept this long for its download, then forgotten. It is never written to disk. */
export const REPORT_TTL_MS = 10 * 60_000;
/** Finished PDFs held at once, in bytes; past it the oldest go first. */
export const REPORT_STORE_MAX_BYTES = 64 * 1024 * 1024;
/** Seconds a refused start is told to wait. */
export const REPORT_RETRY_AFTER_SECONDS = 10;

/** HTTP 503 with Retry-After. */
export class ReportBusyError extends Error {
  override name = "ReportBusyError";
  constructor() {
    super("Other reports are being prepared: try again in a few seconds");
  }
}
/** HTTP 503: this server has no report renderer (its worker or BC Sans wasn't found at startup). */
export class ReportsUnavailableError extends Error {
  override name = "ReportsUnavailableError";
  constructor() {
    super("Reports aren't available on this server right now");
  }
}
/** Not this user's, unknown, or expired: 404, the same answer for each. */
export class ReportJobNotFoundError extends Error {
  override name = "ReportJobNotFoundError";
}
/** HTTP 409: asked for the PDF before it was ready, or after it failed. */
export class ReportJobNotReadyError extends Error {
  override name = "ReportJobNotReadyError";
  constructor() {
    super("The report isn't ready");
  }
}

const FAILURE_TEXT: Record<ReportRenderError["reason"], string> = {
  out_of_memory: "The report is too large to prepare: narrow the filter and run it again.",
  timeout: "The report took too long to prepare: narrow the filter and run it again.",
  failed: "The report couldn't be prepared. Try again.",
};

interface Job {
  id: string;
  owner: string;
  report: ReportKind;
  status: ReportJobView["status"];
  doc: ReportDoc | null;
  bytes: Uint8Array | null;
  error: string | null;
  finishedAt: number | null;
  done: Promise<void>;
  finish: () => void;
}

export interface ReportJobsOptions {
  renderer: PdfRenderer;
  /** Renders at once; each is a worker with its own heap. */
  concurrency: number;
  now?: () => number;
}

/**
 * Report jobs, in this process's memory only: a queue in front of the renderer, at most
 * `concurrency` renders at once, and finished PDFs kept for REPORT_TTL_MS. Every read names its
 * owner; another user's job is "not found". A restart forgets every job, which the user re-runs.
 */
export class ReportJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private readonly sweeper: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly o: ReportJobsOptions) {
    this.now = o.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** Refuses (ReportBusyError) past the queue or the owner's own limit: checked before a report is read or built, and again at its start. */
  assertCanStart(owner: string): void {
    this.sweep();
    const mine = [...this.jobs.values()].filter((j) => j.owner === owner && j.status === "running").length;
    if (this.queue.length >= REPORT_QUEUE_MAX || mine >= REPORT_PER_USER_MAX) throw new ReportBusyError();
  }

  /** Queues a report for `owner`. Refuses (ReportBusyError) past the queue or the owner's own limit. */
  start(owner: string, report: ReportKind, doc: ReportDoc): ReportJobView {
    this.assertCanStart(owner);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const job: Job = { id: randomBytes(16).toString("base64url"), owner, report, status: "running", doc, bytes: null, error: null, finishedAt: null, done, finish };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    return this.viewOf(job);
  }

  /** Resolves when the job finishes or `ms` pass, whichever is first. */
  async settle(owner: string, id: string, ms: number): Promise<ReportJobView> {
    const job = this.own(owner, id);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
    return this.viewOf(job);
  }

  view(owner: string, id: string): ReportJobView {
    return this.viewOf(this.own(owner, id));
  }

  pdf(owner: string, id: string): { report: ReportKind; bytes: Uint8Array } {
    const job = this.own(owner, id);
    if (job.status !== "ready" || !job.bytes) throw new ReportJobNotReadyError();
    return { report: job.report, bytes: job.bytes };
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.queue.length = 0;
    await this.o.renderer.close();
  }

  private own(owner: string, id: string): Job {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new ReportJobNotFoundError();
    return job;
  }

  private viewOf(j: Job): ReportJobView {
    return { id: j.id, report: j.report, status: j.status, error: j.error };
  }

  private pump(): void {
    while (this.running < this.o.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      const doc = job.doc!;
      job.doc = null;
      this.running++;
      this.o.renderer
        .render(doc)
        .then(
          (bytes) => {
            job.bytes = bytes;
            job.status = "ready";
          },
          (e: unknown) => {
            job.status = "failed";
            job.error = FAILURE_TEXT[e instanceof ReportRenderError ? e.reason : "failed"];
            console.error("[calendar] a report failed", safeErrorLabel(e), `POST /calendar/api/reports/${job.report}`);
          },
        )
        .finally(() => {
          job.finishedAt = this.now();
          this.running--;
          job.finish();
          this.sweep();
          this.pump();
        });
    }
  }

  /** Forgets finished jobs past their time, then the oldest finished PDFs past the store's size. */
  private sweep(): void {
    const now = this.now();
    for (const [id, j] of this.jobs) if (j.finishedAt !== null && now - j.finishedAt > REPORT_TTL_MS) this.jobs.delete(id);
    const ready = [...this.jobs.values()].filter((j) => j.bytes).sort((a, b) => a.finishedAt! - b.finishedAt!);
    let held = ready.reduce((n, j) => n + j.bytes!.byteLength, 0);
    for (const j of ready) {
      if (held <= REPORT_STORE_MAX_BYTES) break;
      held -= j.bytes!.byteLength;
      this.jobs.delete(j.id);
    }
  }
}
