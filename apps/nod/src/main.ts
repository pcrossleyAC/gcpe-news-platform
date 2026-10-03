import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authFromEnv } from "@gcpe/auth";
import { eventSecretsSchema, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { createApp } from "./app";
import { distributionClient } from "./distribution-client";
import { distributionTokenProvider } from "./distribution-token";
import { startJobSender } from "./send-jobs";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3004),
    EVENT_SECRETS: eventSecretsSchema,
    DISTRIBUTION_URL: z.string().url(),
    // All four set together → Entra client credentials; none set → a local token (test
    // environments), minted from authFromEnv's own local secret. See distribution-token.ts.
    DISTRIBUTION_TOKEN_URL: z.string().optional(),
    DISTRIBUTION_CLIENT_ID: z.string().optional(),
    DISTRIBUTION_CLIENT_SECRET: z.string().optional(),
    DISTRIBUTION_SCOPE: z.string().optional(),
    // Bounds a single chunk request to Distribution; also sizes send-jobs.ts's claim lock
    // (chunks * this + margin), so a hung request can't outlive the lock protecting it.
    DISTRIBUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    PUBLIC_SITE_URL: z.string().url(),
    MANAGE_URL: z.string().url(),
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  }),
);

const auth = authFromEnv(process.env);
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);

const getDistributionToken = distributionTokenProvider({
  tokenUrl: env.DISTRIBUTION_TOKEN_URL,
  clientId: env.DISTRIBUTION_CLIENT_ID,
  clientSecret: env.DISTRIBUTION_CLIENT_SECRET,
  scope: env.DISTRIBUTION_SCOPE,
  local: auth.local,
});
const distribution = distributionClient({
  baseUrl: env.DISTRIBUTION_URL,
  getToken: getDistributionToken,
  timeoutMs: env.DISTRIBUTION_TIMEOUT_MS,
});

const stopJobSender = startJobSender({
  db,
  distribution,
  manageUrl: env.MANAGE_URL,
  perChunkMs: env.DISTRIBUTION_TIMEOUT_MS,
});

const app = createApp({
  db,
  auth: auth.bearer,
  loginRouter: auth.loginRouter,
  eventSecrets: env.EVENT_SECRETS,
  handlerOptions: { publicSiteUrl: env.PUBLIC_SITE_URL, manageUrl: env.MANAGE_URL },
});
const server = app.listen(env.PORT, () => console.log(`[nod] listening on ${env.PORT}`));

const shutdown = createShutdown({
  logPrefix: "[nod]",
  exit: process.exit,
  closers: [
    { name: "http server", close: () => closeServer(server) },
    { name: "job sender", close: stopJobSender },
    { name: "db pool", close: () => pool.end() },
  ],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
