import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers } from "@gcpe/events";
import { createMssqlSource } from "@gcpe/legacy-import";
import { defaultReportPath, runImportCli } from "./run";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    CORE_DATABASE_URL: z.string().url(),
    LEGACY_SQL_SERVER: z.string().min(1),
    LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
    LEGACY_SQL_USER: z.string().min(1),
    LEGACY_SQL_PASSWORD: z.string().min(1),
    LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
    TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
    // So the reference stage's media_list.updated events reach NoD, the same way
    // apps/nrms/src/start.ts's long-running server parses its own EVENT_SUBSCRIBERS.
    EVENT_SUBSCRIBERS: z.string().optional(),
  }),
);

function parseArgs(argv: string[]): { reportPath?: string; forceWebsite: boolean } {
  let reportPath: string | undefined;
  let forceWebsite = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") {
      reportPath = argv[++i];
    } else if (arg === "--force-website") {
      forceWebsite = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { reportPath, forceWebsite };
}

const { reportPath, forceWebsite } = parseArgs(process.argv.slice(2));
const tenant = loadTenantConfig(env.TENANT_CONFIG);
assertTimeZoneRules(tenant);

const { db, pool } = createDb(env.DATABASE_URL);
const { db: coreDb, pool: corePool } = createDb(env.CORE_DATABASE_URL);
await runMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));

const source = await createMssqlSource({
  server: env.LEGACY_SQL_SERVER,
  database: env.LEGACY_SQL_DATABASE,
  user: env.LEGACY_SQL_USER,
  password: env.LEGACY_SQL_PASSWORD,
  trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true",
});

try {
  process.exitCode = await runImportCli({
    db,
    coreDb,
    source,
    force: forceWebsite,
    timeZone: tenant.timeZone,
    reportPath: reportPath ?? defaultReportPath(),
    subscribers: parseSubscribers(env.EVENT_SUBSCRIBERS),
    log: console.log,
  });
} finally {
  await source.close();
  await pool.end();
  await corePool.end();
}
