import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { MAX_SINCE_DAYS } from "./queries";
import { defaultReportPath, runNodImportCli } from "./run";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    // NRMS's database, read-only: legacy articles resolve to release keys through it.
    NRMS_DATABASE_URL: z.string().url(),
    // Imported release items link here, as NoD's own items do.
    PUBLIC_SITE_URL: z.string().url(),
    LEGACY_SQL_SERVER: z.string().min(1),
    LEGACY_SQL_DATABASE: z.string().default("Gcpe.NewsOnDemand"),
    LEGACY_SQL_USER: z.string().min(1),
    LEGACY_SQL_PASSWORD: z.string().min(1),
    LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
    TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
  }),
);

function parseArgs(argv: string[]): { reportPath?: string; sinceDays: number } {
  let reportPath: string | undefined;
  let sinceDays = 30;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") reportPath = argv[++i];
    else if (arg === "--since-days") sinceDays = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > MAX_SINCE_DAYS) throw new Error(`--since-days must be a whole number from 1 to ${MAX_SINCE_DAYS}`);
  return { reportPath, sinceDays };
}

const { reportPath, sinceDays } = parseArgs(process.argv.slice(2));
const tenant = loadTenantConfig(env.TENANT_CONFIG);
assertTimeZoneRules(tenant);

const { db, pool } = createDb(env.DATABASE_URL);
const { db: nrms, pool: nrmsPool } = createDb(env.NRMS_DATABASE_URL, { max: 2 });
await runMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));
const source = await createMssqlSource({
  server: env.LEGACY_SQL_SERVER,
  database: env.LEGACY_SQL_DATABASE,
  user: env.LEGACY_SQL_USER,
  password: env.LEGACY_SQL_PASSWORD,
  trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true",
});

try {
  process.exitCode = await runNodImportCli({
    db,
    nrms,
    source,
    timeZone: tenant.timeZone,
    sinceDays,
    publicSiteUrl: env.PUBLIC_SITE_URL,
    reportPath: reportPath ?? defaultReportPath(),
    log: console.log,
  });
} finally {
  await source.close();
  await pool.end();
  await nrmsPool.end();
}
