import { z } from "zod";
import { entraIssuer, entraJwks } from "@gcpe/auth";
import { parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3001),
    ENTRA_TENANT_ID: z.string().min(1),
    AUTH_AUDIENCE: z.string().min(1),
    EVENT_SUBSCRIBERS: z.string().optional(),
    MIGRATIONS_FOLDER: z.string().default(new URL("../migrations", import.meta.url).pathname),
  }),
);

const { db } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);
const subscribers = parseSubscribers(env.EVENT_SUBSCRIBERS);
const stopDispatcher = startDispatcher({ db, subscribers });
const app = createApp({
  db,
  subscribers,
  auth: { issuer: entraIssuer(env.ENTRA_TENANT_ID), audience: env.AUTH_AUDIENCE, keys: entraJwks(env.ENTRA_TENANT_ID) },
});
const server = app.listen(env.PORT, () => console.log(`[core] listening on ${env.PORT}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    server.close();
    await stopDispatcher();
    process.exit(0);
  });
}
