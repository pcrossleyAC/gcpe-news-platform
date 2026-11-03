import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb } from "@gcpe/db-kit";
import { parseSubscribers } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { linkLegacyIds, readLegacyReference, type LegacyReference } from "./link-legacy-ids";

// `npm run core:link-legacy-ids -- --export <file>` (where legacy's SQL Server is reachable: LEGACY_SQL_*),
// then `-- --apply <file>` beside Core's database (DATABASE_URL, EVENT_SUBSCRIBERS: names and types),
// a dry run until `--confirm`. See link-legacy-ids.ts for what it changes and what it never does.

const env = parseEnv(z.object({
  DATABASE_URL: z.string().url().optional(),
  EVENT_SUBSCRIBERS: z.string().optional(),
  LEGACY_SQL_SERVER: z.string().min(1).optional(),
  LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
  LEGACY_SQL_USER: z.string().min(1).optional(),
  LEGACY_SQL_PASSWORD: z.string().min(1).optional(),
  LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
}));

const usage = "Use --export <file>, or --apply <file> [--confirm].";
const need = (name: string, value: string | undefined) => {
  if (!value) throw new Error(`${name} is required for this step.`);
  return value;
};

try {
  const [mode, file, flag] = process.argv.slice(2);
  if (!file || (mode !== "--export" && mode !== "--apply") || (flag !== undefined && flag !== "--confirm")) throw new Error(usage);
  if (mode === "--export") {
    const source = await createMssqlSource({ server: need("LEGACY_SQL_SERVER", env.LEGACY_SQL_SERVER), database: env.LEGACY_SQL_DATABASE, user: need("LEGACY_SQL_USER", env.LEGACY_SQL_USER), password: need("LEGACY_SQL_PASSWORD", env.LEGACY_SQL_PASSWORD), trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true" });
    try {
      const ref = await readLegacyReference(source);
      await writeFile(file, JSON.stringify(ref), { mode: 0o600 });
      console.log(`Exported ${ref.ministries.length} ministries and ${ref.terms.length} sectors, themes and tags.`);
    } finally {
      await source.close();
    }
  } else {
    const ref = JSON.parse(await readFile(file, "utf8")) as LegacyReference;
    const { db, pool } = createDb(need("DATABASE_URL", env.DATABASE_URL));
    try {
      console.log(JSON.stringify(await linkLegacyIds(db, ref, parseSubscribers(env.EVENT_SUBSCRIBERS), flag === "--confirm"), null, 2));
      if (flag !== "--confirm") console.log("Dry run: nothing written. Re-run with --confirm.");
    } finally {
      await pool.end();
    }
  }
} catch (e) {
  console.error(e instanceof Error && (e.message === usage || e.message.endsWith("is required for this step.")) ? e.message : safeErrorLabel(e));
  process.exitCode = 1;
}
