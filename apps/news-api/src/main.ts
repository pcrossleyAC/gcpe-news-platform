import { createServer } from "node:http";
import { createClientCredentialsProvider } from "@gcpe/auth";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";
import { newsApiEnvSchema } from "./env";
import { createNewsApiShutdown } from "./shutdown";
import { createUpdatesHub } from "./updates/hub";
import { listenForUpdates } from "./updates/notify";

const env = parseEnv(newsApiEnvSchema);

const tenant = loadTenantConfig(env.TENANT_CONFIG);
// P2-R17: fail fast, loudly, before anything else starts, if this runtime's tzdata disagrees
// with the tenant's pinned (at, expectedOffset) self-check.
assertTimeZoneRules(tenant);
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);

const subscribers = parseSubscribers(env.EVENT_SUBSCRIBERS);
const stopDispatcher = startDispatcher({ db, subscribers });

const getToken =
  env.NOD_TOKEN_URL && env.NOD_CLIENT_ID && env.NOD_CLIENT_SECRET && env.NOD_SCOPE
    ? createClientCredentialsProvider({ tokenUrl: env.NOD_TOKEN_URL, clientId: env.NOD_CLIENT_ID, clientSecret: env.NOD_CLIENT_SECRET, scope: env.NOD_SCOPE })
    : undefined;

// Assigned once listenForUpdates() resolves below; until then readiness reports unavailable.
let isListening = () => false;
const hub = createUpdatesHub({
  negotiateRateLimitPerMinute: env.UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN,
  maxConnections: env.UPDATES_MAX_CONNECTIONS,
  maxConnectionsPerIp: env.UPDATES_MAX_CONNECTIONS_PER_IP,
});
const app = createApp({
  db,
  timeZone: tenant.timeZone,
  eventSecrets: env.EVENT_SECRETS,
  subscribers,
  hubRouter: hub.router,
  // Not ready while the LISTEN connection is down: this instance would silently miss updates.
  readinessChecks: [() => isListening()],
  subscribe: env.NOD_BASE_URL ? { baseUrl: env.NOD_BASE_URL, getToken, rateLimitPerMinute: env.SUBSCRIBE_RATE_LIMIT_PER_MIN, clientIpHeader: env.SUBSCRIBE_CLIENT_IP_HEADER } : undefined,
});
const server = createServer(app);
hub.attach(server);
// onReconnect: the dedicated LISTEN connection can drop and be re-established (network
// blip, Postgres restart/failover) without this process restarting. Notifications that
// arrive during that gap are lost, so once the connection is back we force every SignalR
// client to reconnect (hub.disconnectAll(), ruling P1-R9) rather than try to replay what was
// missed. gcpe-news-webapp clears its caches on reconnect, which is the cheap way to recover
// from a gap whose size we can't otherwise know.
const listener = await listenForUpdates(pool, (target, keys) => hub.broadcast(target, keys), {
  onReconnect: () => hub.disconnectAll(),
});
isListening = listener.isListening;
server.listen(env.PORT, () => console.log(`[news-api] listening on ${env.PORT} (${tenant.tenantId}, ${tenant.timeZone})`));

const shutdown = createNewsApiShutdown({ hub, server, stopListening: listener.stop, stopDispatcher, pool, exit: process.exit });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
