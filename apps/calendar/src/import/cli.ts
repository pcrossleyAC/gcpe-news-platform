import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers, subscribersFor } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { localStore } from "@gcpe/storage";
import { rulesFromTenant } from "../rules";
import { defaultReportPath, ImportArgumentError, parseImportArgs, runCalendarImportCli } from "./run";
import { readSnapshotFile, SnapshotFileError } from "./snapshot-file";

/** A path beside the source in a checkout, or beside the bundled `tools/calendar-import.mjs` in the
 * SiteGround artifact (its migrations at ../migrations/calendar, config at ../config), whichever exists. */
function besideTool(fromSource: string, fromTool: string): string {
  const candidates = [fromSource, fromTool].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/** A legacy SQL setting the live read needs; its name only, never a value, if missing. */
function required(name: string, value: string | undefined): string {
  if (!value) throw new ImportArgumentError(`${name} is required (or pass --snapshot <file>).`);
  return value;
}

const env = parseEnv(z.object({
  DATABASE_URL: z.string().url(),
  CORE_DATABASE_URL: z.string().url(),
  CALENDAR_STORAGE_DIR: z.string().min(1),
  // Not needed with --snapshot <file> (snapshot-file.ts): the read was made where SQL Server is reachable.
  LEGACY_SQL_SERVER: z.string().min(1).optional(),
  LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
  LEGACY_SQL_USER: z.string().min(1).optional(),
  LEGACY_SQL_PASSWORD: z.string().min(1).optional(),
  LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
  TENANT_CONFIG: z.string().default(besideTool("../../../../config/tenants/bc.json", "../config/tenants/bc.json")),
  // Names and types only: the running stack delivers Core's user.upserted by subscriber name.
  CORE_EVENT_SUBSCRIBERS: z.string().optional(),
}));

try {
  const args = parseImportArgs(process.argv.slice(2));
  const tenant = loadTenantConfig(env.TENANT_CONFIG);
  assertTimeZoneRules(tenant);
  const coreSubscribers = parseSubscribers(env.CORE_EVENT_SUBSCRIBERS);
  const names = subscribersFor("user.upserted", coreSubscribers).map((s) => s.name);
  console.log(`user.upserted goes to: ${names.length ? names.join(", ") : "(no subscriber; run Core's republish after the import)"}`);
  const { db, pool } = createDb(env.DATABASE_URL);
  const { db: coreDb, pool: corePool } = createDb(env.CORE_DATABASE_URL);
  await runMigrations(db, besideTool("../../migrations/", "../migrations/calendar/"));
  const rules = rulesFromTenant(tenant);
  const legacy = args.snapshotPath
    ? await readSnapshotFile(args.snapshotPath, { cutoff: args.cutoff, awarenessCategoryIds: rules.awarenessCategoryIds }).then(({ snapshot, readAt }) => {
        console.log(`Reading legacy from the snapshot made ${readAt}.`);
        return { snapshot };
      })
    : { source: await createMssqlSource({ server: required("LEGACY_SQL_SERVER", env.LEGACY_SQL_SERVER), database: env.LEGACY_SQL_DATABASE, user: required("LEGACY_SQL_USER", env.LEGACY_SQL_USER), password: required("LEGACY_SQL_PASSWORD", env.LEGACY_SQL_PASSWORD), trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true" }) };
  try {
    process.exitCode = await runCalendarImportCli(
      { db, coreDb, ...legacy, store: localStore(env.CALENDAR_STORAGE_DIR), rules, coreSubscribers, reportPath: args.reportPath ?? defaultReportPath(), log: console.log },
      { cutoff: args.cutoff, confirm: args.confirm },
    );
    if (!args.confirm && process.exitCode !== 1) console.log("Dry run: nothing written. Re-run with --confirm to import.");
  } finally {
    if ("source" in legacy) await legacy.source.close();
    await pool.end();
    await corePool.end();
  }
} catch (e) {
  console.error(e instanceof ImportArgumentError || e instanceof SnapshotFileError ? e.message : safeErrorLabel(e));
  process.exitCode = 1;
}
