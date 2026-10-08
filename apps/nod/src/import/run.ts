import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { withAdvisoryLock, type Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { importArticles, importDigestCutoff } from "./articles";
import { importLists } from "./lists";
import { Q_UNCONFIRMED_SIGNUPS } from "./queries";
import { NodImportReport } from "./report";
import { importSubscribers } from "./subscribers";

// The "gcpe" two-int advisory lock space (packages/db-kit's MIGRATION_LOCK is 1, nrms:import is 2).
export const NOD_IMPORT_LOCK = [0x67637065, 3] as const;

export class ImportAlreadyRunningError extends Error {
  constructor() {
    super("another nod:import is already running");
    this.name = "ImportAlreadyRunningError";
  }
}

const MAX_MESSAGE = 2_000;

/** A failure message for the report and the console: drizzle's `params:` lines (bound values)
 * are dropped, anything shaped like an address is masked, and the length is capped. */
export function redactMessage(raw: string): string {
  const kept = raw
    .split("\n")
    .filter((l) => !/^\s*params:/.test(l))
    .join("\n")
    .replace(/[^\s@]+@[^\s@]+/g, "(address)")
    .trim();
  return kept.length > MAX_MESSAGE ? `${kept.slice(0, MAX_MESSAGE)}… [truncated]` : kept;
}

export class ImportStageError extends Error {
  constructor(
    public readonly stage: string,
    public readonly report: NodImportReport,
    cause: unknown,
  ) {
    const message = redactMessage(cause instanceof Error ? cause.message : String(cause));
    super(`nod:import failed during ${stage}: ${message}`);
    this.name = "ImportStageError";
    report.markFailed(stage, message);
  }
}

export interface RunNodImportOptions {
  timeZone: string;
  sinceDays: number;
  publicSiteUrl: string;
  log?: (message: string) => void;
}

/** lists → subscribers → recent sends → digest cutoff. Each stage consumes only what earlier
 * ones produced. A failure carries the partial report. */
export async function runNodImport(db: Db, nrms: Db, source: LegacySource, opts: RunNodImportOptions): Promise<NodImportReport> {
  const report = new NodImportReport();
  const log = opts.log ?? (() => {});
  return withAdvisoryLock(db, NOD_IMPORT_LOCK, () => new ImportAlreadyRunningError(), async () => {
    let stage = "lists";
    try {
      const { rows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
      const runAt = new Date(rows[0]!.now);
      const lists = await importLists(db, source, report);
      log("[nod:import] lists mapped");
      stage = "subscribers";
      const subscribers = await importSubscribers(db, source, { report, timeZone: opts.timeZone, lists, runAt });
      log(`[nod:import] subscribers: ${subscribers.size} in NoD from legacy`);
      stage = "articles";
      await importArticles(db, nrms, source, { report, lists, subscribers, sinceDays: opts.sinceDays, publicSiteUrl: opts.publicSiteUrl });
      log("[nod:import] recent sends imported");
      stage = "settings";
      await importDigestCutoff(db, source, report);
      const [signups] = await source.query<{ Signups: number }>(Q_UNCONFIRMED_SIGNUPS);
      report.note(`${signups?.Signups ?? 0} signups were waiting for confirmation in legacy and were not imported: those people must sign up again.`);
      return report;
    } catch (e) {
      throw new ImportStageError(stage, report, e);
    }
  });
}

/** `nod-import-<UTC timestamp>.json`. */
export function defaultReportPath(now: Date = new Date()): string {
  return `nod-import-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}

async function writeReportFiles(report: NodImportReport, jsonPath: string): Promise<void> {
  await writeFile(jsonPath, JSON.stringify(report.toJSON(), null, 2));
  await writeFile(jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.txt` : `${jsonPath}.txt`, report.toText());
}

export interface RunNodImportCliOptions extends RunNodImportOptions {
  db: Db;
  nrms: Db;
  source: LegacySource;
  reportPath: string;
}

/** The CLI minus env and argv: 0 balanced, 2 not balanced, 1 on any error (a partial report is
 * still written) or when another run holds the lock. */
export async function runNodImportCli(opts: RunNodImportCliOptions): Promise<0 | 1 | 2> {
  const log = opts.log ?? (() => {});
  try {
    const report = await runNodImport(opts.db, opts.nrms, opts.source, opts);
    await writeReportFiles(report, opts.reportPath);
    log(report.toText());
    return report.balanced() ? 0 : 2;
  } catch (e) {
    if (e instanceof ImportStageError) {
      await writeReportFiles(e.report, opts.reportPath);
      log(e.message);
      return 1;
    }
    log(e instanceof ImportAlreadyRunningError ? e.message : redactMessage(e instanceof Error ? e.message : String(e)));
    return 1;
  }
}
