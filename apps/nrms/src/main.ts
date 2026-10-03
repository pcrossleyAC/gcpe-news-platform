import { z } from "zod";
import { authFromEnv } from "@gcpe/auth";
import { parseEnv } from "@gcpe/config";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";
import { startPublisher } from "./publisher";
import { fileURLToPath } from "node:url";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3002),
    EVENT_SUBSCRIBERS: z.string().optional(),
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
    PUBLISH_INTERVAL_MS: z.coerce.number().int().default(60000),
  }),
);

const auth = authFromEnv(process.env);
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);
const subscribers = parseSubscribers(env.EVENT_SUBSCRIBERS);
const stopDispatcher = startDispatcher({ db, subscribers });
const stopPublisher = startPublisher({ db, subscribers, intervalMs: env.PUBLISH_INTERVAL_MS });
const app = createApp({
  db,
  auth: auth.bearer,
  loginRouter: auth.loginRouter,
});
const server = app.listen(env.PORT, () => console.log(`[nrms] listening on ${env.PORT}`));

const shutdown = createShutdown({
  logPrefix: "[nrms]",
  exit: process.exit,
  closers: [
    { name: "http server", close: () => closeServer(server) },
    { name: "publisher", close: stopPublisher },
    { name: "event dispatcher", close: stopDispatcher },
    { name: "db pool", close: () => pool.end() },
  ],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
