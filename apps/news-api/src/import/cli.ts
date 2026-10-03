import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { importLegacyNews } from "./run";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    LEGACY_SQL_SERVER: z.string().min(1),
    LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
    LEGACY_SQL_USER: z.string().min(1),
    LEGACY_SQL_PASSWORD: z.string().min(1),
    LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
  }),
);

const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, new URL("../../migrations", import.meta.url).pathname);
const source = await createMssqlSource({
  server: env.LEGACY_SQL_SERVER,
  database: env.LEGACY_SQL_DATABASE,
  user: env.LEGACY_SQL_USER,
  password: env.LEGACY_SQL_PASSWORD,
  trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true",
});
try {
  console.log(JSON.stringify(await importLegacyNews(db, source, { log: console.log }), null, 2));
} finally {
  await source.close();
  await pool.end();
}
