import { createServer } from "node:http";
import { createClientCredentialsProvider } from "@gcpe/auth";
import { loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createApp } from "./app";
import { newsApiEnvSchema } from "./env";
import { createShutdown } from "./shutdown";
import { createUpdatesHub } from "./updates/hub";
import { listenForUpdates } from "./updates/notify";

const env = parseEnv(newsApiEnvSchema);

const tenant = loadTenantConfig(env.TENANT_CONFIG);
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);

const getToken =
  env.NOD_TOKEN_URL && env.NOD_CLIENT_ID && env.NOD_CLIENT_SECRET && env.NOD_SCOPE
    ? createClientCredentialsProvider({ tokenUrl: env.NOD_TOKEN_URL, clientId: env.NOD_CLIENT_ID, clientSecret: env.NOD_CLIENT_SECRET, scope: env.NOD_SCOPE })
    : undefined;

const hub = createUpdatesHub();
const app = createApp({
  db,
  timeZone: tenant.timeZone,
  eventSecrets: env.EVENT_SECRETS,
  hubRouter: hub.router,
  subscribe: env.NOD_BASE_URL ? { baseUrl: env.NOD_BASE_URL, getToken, rateLimitPerMinute: env.SUBSCRIBE_RATE_LIMIT_PER_MIN } : undefined,
});
const server = createServer(app);
hub.attach(server);
// onReconnect: the dedicated LISTEN connection can drop and be re-established (network
// blip, Postgres restart/failover) without this process restarting. Notifications that
// arrive during that gap are lost, so once the connection is back we force every SignalR
// client to reconnect (hub.disconnectAll(), ruling P1-R9) rather than try to replay what was
// missed. gcpe-news-webapp clears its caches on reconnect, which is the cheap way to recover
// from a gap whose size we can't otherwise know.
const stopListening = await listenForUpdates(pool, (target, keys) => hub.broadcast(target, keys), {
  onReconnect: () => hub.disconnectAll(),
});
server.listen(env.PORT, () => console.log(`[news-api] listening on ${env.PORT} (${tenant.tenantId}, ${tenant.timeZone})`));

const shutdown = createShutdown({ hub, server, stopListening, pool, exit: process.exit });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
