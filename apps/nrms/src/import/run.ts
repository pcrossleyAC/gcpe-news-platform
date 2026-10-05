/**
 * Phase 3e (NRMS legacy importer, spec §8, task 5): the orchestrator that wires Tasks 1-4
 * together into one run — Core users, then NRMS's own reference tables, then releases, then
 * website data — plus the whole-run exclusivity lock and report plumbing the CLI needs.
 *
 * Run order (controller ruling): users (Core) -> reference -> releases -> website. Each stage
 * consumes only what earlier stages produced (page image/media list/term ids, the legacy-user
 * map), matching the codemap's §1-§7 dependency order. A stage's failure stops the run — the
 * error thrown carries whatever the report accumulated before the failure, so the CLI can still
 * write a partial report and exit 1, instead of losing everything a long run had already done.
 */
import { writeFile } from "node:fs/promises";
import pg from "pg";
import type { Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { importLegacyUsers } from "../../../core/src/import/users";
import { legacyUserMap, type LegacyUserRow } from "./map";
import { importReference } from "./reference";
import { importReleases, type ImportReleasesContext } from "./releases";
import { Q_USERS } from "./queries";
import { ImportReport } from "./report";
import { importWebsite } from "./website";

// Two-int advisory keys live in their own lock space (see packages/db-kit/src/db.ts's
// MIGRATION_LOCK comment) -- "gcpe" namespace, second key 2 so it can never collide with the
// migration lock (second key 1) or a per-aggregate `pg_advisory_xact_lock(hashtext(...))` call
// (those use the single-bigint form, a different lock space again).
export const IMPORT_LOCK = [0x67637065, 2] as const;

export class ImportAlreadyRunningError extends Error {
  constructor() {
    super("another nrms:import is already running");
  }
}

/** Carries the partial report accumulated before `stage` failed, so a caller can still write it. */
export class ImportStageError extends Error {
  constructor(
    public readonly stage: string,
    public readonly report: ImportReport,
    public readonly cause: unknown,
  ) {
    super(`nrms:import failed during ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

type PgConnection = pg.PoolClient | pg.Client;

/**
 * Holds a session-level `pg_try_advisory_lock` for the duration of `fn`, on a dedicated
 * connection (never a pooled one query-by-query) so the lock can't be silently dropped between
 * statements. Throws {@link ImportAlreadyRunningError} without running `fn` at all when another
 * run already holds it.
 */
async function withImportLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const client = (db as Db & { $client: pg.Pool | pg.Client }).$client;
  const conn: PgConnection = client instanceof pg.Pool ? await client.connect() : client;
  const release = (broken: boolean) => {
    if ("release" in conn && typeof conn.release === "function") conn.release(broken);
  };
  const { rows } = await conn.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [...IMPORT_LOCK]);
  if (!rows[0]?.locked) {
    release(false);
    throw new ImportAlreadyRunningError();
  }
  let broken = false;
  try {
    return await fn();
  } finally {
    await conn.query("SELECT pg_advisory_unlock($1, $2)", [...IMPORT_LOCK]).catch(() => {
      broken = true; // closing the connection releases the lock anyway
    });
    release(broken);
  }
}

export interface RunImportOptions {
  /** Forces the website stage even when nothing changed since the last import (import/website.ts). */
  force: boolean;
  /** The tenant's time zone (e.g. "America/Vancouver") -- not used directly here yet, but part
   * of the agreed interface for stages that need BC-local dates. */
  timeZone: string;
  log?: (message: string) => void;
}

/**
 * Runs every importer stage once, inside the whole-run advisory lock. Returns the completed
 * report on success. On a stage failure, throws {@link ImportStageError} (its `.report` holds
 * everything counted before the failure) rather than swallowing the partial progress.
 */
export async function runImport(db: Db, coreDb: Db, source: LegacySource, opts: RunImportOptions): Promise<ImportReport> {
  const report = new ImportReport();
  const log = opts.log ?? (() => {});

  return withImportLock(db, async () => {
    let stage = "users";
    try {
      const legacyUserRows = await source.query<LegacyUserRow>(Q_USERS);
      report.count("users", "legacy", legacyUserRows.length);
      const { users: emailMap, skipped } = await importLegacyUsers(
        coreDb,
        legacyUserRows.map((r) => ({ email: r.EmailAddress ?? "", displayName: r.DisplayName ?? "" })),
      );
      for (const s of skipped) report.skip("users", s.email || "(empty email)", s.reason);
      report.count("users", "imported", legacyUserRows.length - skipped.length);
      const users = legacyUserMap(legacyUserRows, emailMap);
      log(`[nrms:import] users: ${legacyUserRows.length} legacy, ${skipped.length} skipped`);

      stage = "reference";
      const { pageImageIds, mediaListIds, termIds } = await importReference(db, source, report);
      log("[nrms:import] reference data imported");

      stage = "releases";
      const ctx: ImportReleasesContext = { pageImageIds, mediaListIds, termIds, users, report, timeZone: opts.timeZone };
      await importReleases(db, source, ctx);
      log("[nrms:import] releases imported");

      stage = "website";
      await importWebsite(db, source, report, { force: opts.force });
      log("[nrms:import] website data imported");

      return report;
    } catch (e) {
      throw new ImportStageError(stage, report, e);
    }
  });
}

function reportTextPath(jsonPath: string): string {
  return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.txt` : `${jsonPath}.txt`;
}

/** `nrms-import-<UTC timestamp>.json`, compact so it's safe as a filename everywhere. */
export function defaultReportPath(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `nrms-import-${ts}.json`;
}

async function writeReportFiles(report: ImportReport, jsonPath: string): Promise<void> {
  await writeFile(jsonPath, JSON.stringify(report.toJSON(), null, 2));
  await writeFile(reportTextPath(jsonPath), report.toText());
}

export interface RunImportCliOptions {
  db: Db;
  coreDb: Db;
  source: LegacySource;
  force: boolean;
  timeZone: string;
  reportPath: string;
  log?: (message: string) => void;
}

/**
 * The CLI's whole job, minus env/argv parsing: run the import, write the report (even a partial
 * one, on a stage failure), and decide the exit code. Kept here (not in cli.ts) so it can be
 * exercised with a fake source and test databases, without ever importing cli.ts itself (which
 * has top-level side effects -- parsing real env, opening a real SQL Server connection).
 *
 * Exit codes (controller ruling): 0 balanced, 2 not balanced, 1 on any error (including another
 * run already holding the lock) -- checked in that priority order, an error always wins over a
 * balance verdict since a thrown stage failure never reaches the balance check at all.
 */
export async function runImportCli(opts: RunImportCliOptions): Promise<number> {
  const log = opts.log ?? (() => {});
  try {
    const report = await runImport(opts.db, opts.coreDb, opts.source, { force: opts.force, timeZone: opts.timeZone, log });
    await writeReportFiles(report, opts.reportPath);
    log(report.toText());
    return report.balanced() ? 0 : 2;
  } catch (e) {
    if (e instanceof ImportAlreadyRunningError) {
      log(e.message);
      return 1;
    }
    if (e instanceof ImportStageError) {
      await writeReportFiles(e.report, opts.reportPath);
      log(e.message);
      return 1;
    }
    log(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
