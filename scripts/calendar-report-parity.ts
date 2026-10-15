#!/usr/bin/env -S node --
// The report parity check (spec addendum §12.3) on legacy's survey-08 Part B export: the CSV
// snapshot goes into throwaway Core and Calendar databases, our four reports are rendered for the
// legacy PDFs' range and filter as an HQ System Administrator, and each pair is compared.
//
// Usage:
//   npm run calendar:report-parity -- --csv <file> [--csv <file> …] [--part-c <file>] --legacy-dir <folder>
//     --out <folder> --cutoff <date> --from <date> --to <date> --to-30-60-90 <date> [--now <ISO>] [--keep-dbs]
//
// The CSVs and legacy PDFs hold real activities and people. Everything this writes goes under --out,
// which must be outside this repository (mode 700). The databases are dropped at the end, also on
// failure. It prints counts and file names only. Exit code 0 when every pair matches, 1 when any
// differs, 2 on an error.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { asc } from "drizzle-orm";
import { getDocumentProxy } from "unpdf";
import { CALENDAR_LEVELS } from "@gcpe/auth";
import { bcDateSchema, listQuerySchema, type ReportKind } from "@gcpe/calendar-contract";
import { loadTenantConfig } from "@gcpe/config";
import { createTestDatabase, type Db } from "@gcpe/db-kit";
import { outboxEvents, type EventEnvelope } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { localStore } from "@gcpe/storage";
import type { CalendarActor } from "../apps/calendar/src/actor";
import { CsvSnapshotError, snapshotFromCsv, type CsvFile } from "../apps/calendar/src/import/csv-snapshot";
import { runCalendarImport } from "../apps/calendar/src/import/run";
import { projectionHandler } from "../apps/calendar/src/projections";
import { buildReport } from "../apps/calendar/src/reports/build";
import { reportData } from "../apps/calendar/src/reports/data";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { renderPdf, useBcSans } from "../apps/calendar/src/reports/render/pdf";
import { rulesFromTenant } from "../apps/calendar/src/rules";
import { republishAll } from "../apps/core/src/services/republish";
import { compareReports, insideRepo, type RowCounts } from "./calendar-report-compare";
import { seedCoreFromLegacyKeys } from "./lib/calendar-parity-core";

const ROOT = resolve(import.meta.dirname, "..");
const CAL_MIGRATIONS = join(ROOT, "apps", "calendar", "migrations");
const CORE_MIGRATIONS = join(ROOT, "apps", "core", "migrations");
/** Our rows link here; only the path matters to the comparison. */
const ORIGIN = "https://calendar-parity.example.test";

/** The four reports and the legacy file each is compared with. The 30-60-90 runs to --to-30-60-90. */
export const REPORTS: readonly { kind: ReportKind; legacy: string }[] = [
  { kind: "look-ahead", legacy: "LookAhead.pdf" },
  { kind: "exec-look-ahead", legacy: "ExecLookAhead.pdf" },
  { kind: "planning", legacy: "Planning.pdf" },
  { kind: "30-60-90", legacy: "30-60-90.pdf" },
];

export interface ParityOptions {
  csv: string[]; partC: string | null; legacyDir: string; out: string;
  cutoff: string; from: string; to: string; to90: string;
  /** "Now" for every report; null takes each legacy PDF's creation date. */
  now: Date | null; keepDbs: boolean; tenantConfig: string;
  log?: (s: string) => void;
}
export interface ParityResult { activities: number; reports: { kind: ReportKind; same: boolean; outlineChanges: number; rows: RowCounts }[] }
/** A bad command line: its message is ours, safe to print. */
export class ParityArgumentError extends Error { override name = "ParityArgumentError"; }

export function parseParityArgs(argv: string[]): ParityOptions {
  const o: Partial<ParityOptions> & { csv: string[] } = { csv: [], partC: null, now: null, keepDbs: false, tenantConfig: join(ROOT, "config", "tenants", "bc.json") };
  const value = (i: number, name: string) => { const v = argv[i]; if (!v || v.startsWith("--")) throw new ParityArgumentError(`${name} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--csv") o.csv.push(value(++i, a));
    else if (a === "--part-c") o.partC = value(++i, a);
    else if (a === "--legacy-dir") o.legacyDir = value(++i, a);
    else if (a === "--out") o.out = value(++i, a);
    else if (a === "--cutoff") o.cutoff = value(++i, a);
    else if (a === "--from") o.from = value(++i, a);
    else if (a === "--to") o.to = value(++i, a);
    else if (a === "--to-30-60-90") o.to90 = value(++i, a);
    else if (a === "--tenant") o.tenantConfig = value(++i, a);
    else if (a === "--keep-dbs") o.keepDbs = true;
    else if (a === "--now") { const d = new Date(value(++i, a)); if (Number.isNaN(d.getTime())) throw new ParityArgumentError("--now must be an ISO date and time"); o.now = d; }
    else throw new ParityArgumentError(`Unknown argument: ${a}`);
  }
  if (o.csv.length === 0) throw new ParityArgumentError("--csv <file> is required (once per file)");
  for (const k of ["legacyDir", "out"] as const) if (!o[k]) throw new ParityArgumentError(`--${k === "legacyDir" ? "legacy-dir" : "out"} is required`);
  for (const [k, flag] of [["cutoff", "--cutoff"], ["from", "--from"], ["to", "--to"], ["to90", "--to-30-60-90"]] as const) {
    if (!o[k] || !bcDateSchema.safeParse(o[k]).success) throw new ParityArgumentError(`${flag} must be a real date, YYYY-MM-DD`);
  }
  if (o.from! < o.cutoff!) throw new ParityArgumentError("--from must be on or after --cutoff, so both sides hold the same activities");
  if (o.to! < o.from! || o.to90! < o.from!) throw new ParityArgumentError("--to and --to-30-60-90 must be on or after --from");
  return o as ParityOptions;
}

/** A PDF date ("D:YYYYMMDDHHmmSS-07'00'", or …Z) as an instant, or null. */
export function parsePdfDate(raw: string): Date | null {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:(Z)|([+-])(\d{2})'(\d{2})'?)?$/.exec(raw.trim());
  if (!m) return null;
  const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (+m[9]! * 60 + +m[10]!) : 0;
  return new Date(utc - offset * 60_000);
}
export async function pdfCreatedAt(path: string): Promise<Date | null> {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)), { verbosity: 0 });
  const info = (await pdf.getMetadata()).info as { CreationDate?: unknown };
  return typeof info.CreationDate === "string" ? parsePdfDate(info.CreationDate) : null;
}

/** Core's organisations, terms and users into the Calendar's projections, through the real events, in process. */
export async function projectCoreIntoCalendar(coreDb: Db, calDb: Db): Promise<number> {
  await republishAll(coreDb, []);
  const rows = await coreDb.select({ envelope: outboxEvents.envelope }).from(outboxEvents).orderBy(asc(outboxEvents.aggregateId), asc(outboxEvents.sequence));
  let applied = 0;
  for (const { envelope } of rows) {
    const e = envelope as EventEnvelope;
    const handle = projectionHandler(e);
    if (!handle) continue;
    await calDb.transaction((tx) => handle(tx, e));
    applied++;
  }
  return applied;
}

const readFile = (p: string): CsvFile => ({ name: basename(p), bytes: new Uint8Array(readFileSync(p)) });

/** Everything this creates holds real data, so files and folders are owner-only whatever the caller's umask. */
export async function runParity(o: ParityOptions): Promise<ParityResult> {
  const previousUmask = process.umask(0o077);
  try {
    return await runParityUnmasked(o);
  } finally {
    process.umask(previousUmask);
  }
}

async function runParityUnmasked(o: ParityOptions): Promise<ParityResult> {
  const log = o.log ?? (() => {});
  if (insideRepo(o.out)) throw new ParityArgumentError("--out must be outside the repository: the run holds real activities");
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  chmodSync(o.out, 0o700);
  const { snapshot, keys, encodings, ignoredSections } = snapshotFromCsv(o.csv.map(readFile), { partC: o.partC ? readFile(o.partC) : undefined, usersFromCommContacts: true });
  log(`Read ${snapshot.activities.length} activities from ${o.csv.length} files (${Object.entries(encodings).map(([f, e]) => `${f}: ${e}`).join("; ")}). Ignored sections: ${ignoredSections.join(", ") || "none"}.`);
  const rules = rulesFromTenant(loadTenantConfig(o.tenantConfig));
  const cal = await createTestDatabase({ migrationsFolder: CAL_MIGRATIONS });
  const core = await createTestDatabase({ migrationsFolder: CORE_MIGRATIONS }).catch(async (e: unknown) => { await cal.drop(); throw e; });
  try {
    const hqKey = await seedCoreFromLegacyKeys(core.db, keys);
    mkdirSync(join(o.out, "store"), { recursive: true, mode: 0o700 });
    const report = await runCalendarImport({ db: cal.db, coreDb: core.db, snapshot, store: localStore(join(o.out, "store")), rules, coreSubscribers: [] }, { cutoff: o.cutoff, confirm: true });
    writeFileSync(join(o.out, "import-report.json"), JSON.stringify(report.toJSON(), null, 2));
    writeFileSync(join(o.out, "import-report.txt"), report.toText());
    const inserted = report.toJSON().tables.activities?.inserted ?? 0;
    log(`Imported ${inserted} of ${snapshot.activities.length} activities (${report.balanced() ? "balanced" : "NOT BALANCED"}).`);
    if (!report.balanced() || inserted !== snapshot.activities.length) throw new Error("the import didn't take every activity: see import-report.txt");
    log(`Projected ${await projectCoreIntoCalendar(core.db, cal.db)} Core events into the Calendar.`);

    const actor: CalendarActor = { userId: randomUUID(), displayName: "Parity runner", role: "Calendar.SysAdmin", level: CALENDAR_LEVELS["Calendar.SysAdmin"], ministryKeys: [hqKey], isHq: true };
    useBcSans(reportAssets().fontsDir);
    mkdirSync(join(o.out, "ours"), { recursive: true, mode: 0o700 });
    const reports: ParityResult["reports"] = [];
    for (const r of REPORTS) {
      const legacy = join(o.legacyDir, r.legacy);
      const now = o.now ?? (await pdfCreatedAt(legacy));
      if (!now) throw new ParityArgumentError(`${r.legacy} has no creation date: pass --now`);
      const q = listQuerySchema.parse({ filter: { from: o.from, to: r.kind === "30-60-90" ? o.to90 : o.to } });
      const data = await reportData({ db: cal.db, rules, subscribers: [], now: () => now }, actor, q);
      const ours = join(o.out, "ours", r.legacy);
      writeFileSync(ours, await renderPdf(buildReport(r.kind, data, ORIGIN)));
      const c = await compareReports({ legacy, ours, out: join(o.out, "compare", r.kind) });
      reports.push({ kind: r.kind, same: c.same, outlineChanges: c.diff.filter((l) => !l.startsWith("  ")).length, rows: c.rows });
      log(`${r.kind}: ${data.rows.length} activities read; ${c.same ? "matches" : "differs"}.`);
    }
    const result: ParityResult = { activities: snapshot.activities.length, reports };
    writeFileSync(join(o.out, "summary.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (o.keepDbs) log(`Kept the databases: ${new URL(cal.url).pathname.slice(1)} and ${new URL(core.url).pathname.slice(1)}. They hold real data: drop them when done.`);
    else { await Promise.all([cal.drop(), core.drop()]); log("Dropped the throwaway databases."); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await runParity({ ...parseParityArgs(process.argv.slice(2)), log: console.log });
    for (const x of r.reports) console.log(`${x.kind}: ${x.same ? "matches" : `${x.outlineChanges} outline lines differ; rows: ${x.rows.differ} differ, ${x.rows.onlyLegacy} only in legacy, ${x.rows.onlyOurs} only in ours`}`);
    process.exitCode = r.reports.every((x) => x.same) ? 0 : 1;
  } catch (e) {
    console.error(e instanceof ParityArgumentError || e instanceof CsvSnapshotError ? e.message : safeErrorLabel(e));
    process.exitCode = 2;
  }
}
