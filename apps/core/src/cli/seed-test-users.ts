import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { readHidden } from "@gcpe/auth/cli/read-hidden";
import { seedTestUsers, TEST_USERS } from "../services/seed-test-users";

const env = parseEnv(z.object({ DATABASE_URL: z.string().url() }), process.env);
const passwords: Record<string, string> = {};
for (const u of TEST_USERS) passwords[u.email] = await readHidden(`Password for ${u.email} (${u.roles.join(", ")}; input hidden): `);

const { db, pool } = createDb(env.DATABASE_URL);
try {
  await runMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));
  for (const r of await seedTestUsers(db, passwords))
    console.log(`${r.action.padEnd(8)} ${r.email}${r.calendar ? ` (calendar ${r.calendar}${r.missingOrganizations ? `: missing ${r.missingOrganizations.join(", ")}` : ""})` : ""}`);
} finally {
  await pool.end();
}
