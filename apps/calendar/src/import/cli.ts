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

const env = parseEnv(z.object({
  DATABASE_URL: z.string().url(),
  CORE_DATABASE_URL: z.string().url(),
  CALENDAR_STORAGE_DIR: z.string().min(1),
  LEGACY_SQL_SERVER: z.string().min(1),
  LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
  LEGACY_SQL_USER: z.string().min(1),
  LEGACY_SQL_PASSWORD: z.string().min(1),
  LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
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
  await runMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));
  const source = await createMssqlSource({ server: env.LEGACY_SQL_SERVER, database: env.LEGACY_SQL_DATABASE, user: env.LEGACY_SQL_USER, password: env.LEGACY_SQL_PASSWORD, trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true" });
  try {
    process.exitCode = await runCalendarImportCli(
      { db, coreDb, source, store: localStore(env.CALENDAR_STORAGE_DIR), rules: rulesFromTenant(tenant), coreSubscribers, reportPath: args.reportPath ?? defaultReportPath(), log: console.log },
      { cutoff: args.cutoff, confirm: args.confirm },
    );
    if (!args.confirm && process.exitCode !== 1) console.log("Dry run: nothing written. Re-run with --confirm to import.");
  } finally {
    await source.close();
    await pool.end();
    await corePool.end();
  }
} catch (e) {
  console.error(e instanceof ImportArgumentError ? e.message : safeErrorLabel(e));
  process.exitCode = 1;
}
