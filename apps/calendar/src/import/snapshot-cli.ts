import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { safeErrorLabel } from "@gcpe/http-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { rulesFromTenant } from "../rules";
import { loadLegacy } from "./load";
import { ImportArgumentError } from "./run";
import { writeSnapshotFile } from "./snapshot-file";

// `npm run calendar:snapshot -- --cutoff <YYYY-MM-DD> --out <file>`: reads legacy's SQL Server as
// `calendar:import` would, writes nothing anywhere else, and saves the read to <file> for
// `calendar:import -- --snapshot <file>` on a machine that can't reach SQL Server (snapshot-file.ts).
// The file holds legacy data: keep it private and delete it once imported.

const env = parseEnv(z.object({
  LEGACY_SQL_SERVER: z.string().min(1),
  LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
  LEGACY_SQL_USER: z.string().min(1),
  LEGACY_SQL_PASSWORD: z.string().min(1),
  LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
}));

export function parseSnapshotArgs(argv: string[]): { cutoff: string; out: string } {
  let cutoff: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cutoff") cutoff = argv[++i];
    else if (a === "--out") out = argv[++i];
    else throw new ImportArgumentError(`Unknown argument: ${a}`);
  }
  if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new ImportArgumentError("--cutoff <YYYY-MM-DD> is required, the same one the import will use");
  if (!out) throw new ImportArgumentError("--out <file> is required");
  return { cutoff, out };
}

try {
  const args = parseSnapshotArgs(process.argv.slice(2));
  const tenant = loadTenantConfig(env.TENANT_CONFIG);
  assertTimeZoneRules(tenant);
  const scope = { cutoff: args.cutoff, awarenessCategoryIds: rulesFromTenant(tenant).awarenessCategoryIds };
  const source = await createMssqlSource({ server: env.LEGACY_SQL_SERVER, database: env.LEGACY_SQL_DATABASE, user: env.LEGACY_SQL_USER, password: env.LEGACY_SQL_PASSWORD, trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true" });
  try {
    const s = await loadLegacy(source, scope);
    const bytes = await writeSnapshotFile(args.out, s, scope);
    console.log(`Snapshot written: ${s.activities.length} activities (of ${s.totals.activities}), ${s.users.length} users, ${s.commContacts.length} comm contacts, ${s.files.length} files, ${s.logs.length} history rows; ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
  } finally {
    await source.close();
  }
} catch (e) {
  console.error(e instanceof ImportArgumentError ? e.message : safeErrorLabel(e));
  process.exitCode = 1;
}
