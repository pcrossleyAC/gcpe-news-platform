import type { Server } from "node:http";
import express from "express";
import { authFromEnv, NOD_SUBSCRIBE_API_ROLE, serviceTokenProvider } from "@gcpe/auth";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import type { Closer } from "@gcpe/http-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";
import { newsApiEnvSchema } from "./env";
import { createUpdatesHub } from "./updates/hub";
import { listenForUpdates } from "./updates/notify";

export interface AppHandle {
  app: express.Express;
  /** Parsed PORT (same env var/default as before) — main.ts listens on this; nothing new to
   * parse there. */
  port: number;
  /** Tenant id/time zone (for main.ts's listening log line — unchanged text). */
  tenantId: string;
  timeZone: string;
  /** One iteration of each background loop, using the same function and options the loop
   * itself uses. The hub's ping timer and the LISTEN connection are not loops of this kind
   * — there is no "run once" for them. */
  workers: Record<string, () => Promise<unknown>>;
  /** Starts the interval loops exactly as main.ts does today. */
  startLoops(): void;
  /** Wires the SignalR hub's WebSocket upgrade handling to the http server. Present only
   * when the hub is enabled (`opts.hub`, default true). */
  attach?(server: Server): void;
  /**
   * Closers that must run *before* the http server closes. With the hub enabled (the
   * production default) this is `[updates hub]` — a connected /updates client otherwise
   * blocks server.close() forever (see updates/hub.ts and start.test.ts's
   * "doesn't hang with a connected /updates client" regression test). Empty when the hub is
   * disabled. main.ts (and the stack) build the shutdown order uniformly as
   * `[...closeBeforeServer, httpServer, ...closers]`, with no app-specific special-casing.
   */
  closeBeforeServer: Closer[];
  /**
   * The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). With the hub enabled this is `[LISTEN
   * connection, event dispatcher, db pool]`; with it disabled, `[event dispatcher, db pool]`.
   */
  closers: Closer[];
}

/**
 * Wires up everything News API's main.ts needs: parses env, loads + self-checks the tenant
 * config, runs migrations, builds the SignalR updates hub and its Postgres LISTEN connection,
 * and the Express app. Identical behaviour to the former main.ts.
 *
 * `opts.hub` (default true): when false, no hub router is mounted, no LISTEN connection is
 * opened, and `/health/ready` no longer depends on it — used by tests that only need the
 * HTTP surface (e.g. `/updates/negotiate` should then 404).
 */
export async function startNewsApi(env: NodeJS.ProcessEnv, opts: { hub?: boolean } = {}): Promise<AppHandle> {
  const hubEnabled = opts.hub ?? true;

  const parsed = parseEnv(newsApiEnvSchema, env);

  const tenant = loadTenantConfig(parsed.TENANT_CONFIG);
  // P2-R17: fail fast, loudly, before anything else starts, if this runtime's tzdata
  // disagrees with the tenant's pinned (at, expectedOffset) self-check.
  assertTimeZoneRules(tenant);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);

  const subscribers = parseSubscribers(parsed.EVENT_SUBSCRIBERS);

  const nodEntra = [parsed.NOD_TOKEN_URL, parsed.NOD_CLIENT_ID, parsed.NOD_CLIENT_SECRET, parsed.NOD_SCOPE];
  // Entra when configured; otherwise, on test sites, a local token carrying the subscribe
  // role (same fallback NRMS uses for its NoD calls).
  const getToken = parsed.NOD_BASE_URL
    ? serviceTokenProvider({
        tokenUrl: parsed.NOD_TOKEN_URL, clientId: parsed.NOD_CLIENT_ID, clientSecret: parsed.NOD_CLIENT_SECRET, scope: parsed.NOD_SCOPE,
        local: nodEntra.every((v) => !v) && env.LOCAL_ADMIN_ENABLED === "true" ? authFromEnv(env).local : null,
        subject: "news-api",
        roles: [NOD_SUBSCRIBE_API_ROLE],
        envPrefix: "NOD",
      })
    : undefined;

  // Assigned once listenForUpdates() resolves below; until then readiness reports
  // unavailable. Read through this mutable binding (not captured by value) so createApp's
  // readinessChecks closure below sees the real listener once it exists.
  let isListening = () => false;
  const hub = hubEnabled
    ? createUpdatesHub({
        negotiateRateLimitPerMinute: parsed.UPDATES_NEGOTIATE_RATE_LIMIT_PER_MIN,
        maxConnections: parsed.UPDATES_MAX_CONNECTIONS,
        maxConnectionsPerIp: parsed.UPDATES_MAX_CONNECTIONS_PER_IP,
      })
    : undefined;

  const app = createApp({
    db,
    timeZone: tenant.timeZone,
    eventSecrets: parsed.EVENT_SECRETS,
    subscribers,
    hubRouter: hub?.router,
    // Not ready while the LISTEN connection is down: this instance would silently miss
    // updates. Omitted entirely when the hub is disabled.
    readinessChecks: hubEnabled ? [() => isListening()] : [],
    subscribe: parsed.NOD_BASE_URL
      ? { baseUrl: parsed.NOD_BASE_URL, getToken, rateLimitPerMinute: parsed.SUBSCRIBE_RATE_LIMIT_PER_MIN, clientIpHeader: parsed.SUBSCRIBE_CLIENT_IP_HEADER }
      : undefined,
  });

  let stopListening: (() => Promise<void>) | undefined;
  if (hub) {
    // onReconnect: the dedicated LISTEN connection can drop and be re-established (network
    // blip, Postgres restart/failover) without this process restarting. Notifications that
    // arrive during that gap are lost, so once the connection is back we force every
    // SignalR client to reconnect (hub.disconnectAll(), ruling P1-R9) rather than try to
    // replay what was missed. gcpe-news-webapp clears its caches on reconnect, which is the
    // cheap way to recover from a gap whose size we can't otherwise know.
    const listener = await listenForUpdates(pool, (target, keys) => hub.broadcast(target, keys), {
      onReconnect: () => hub.disconnectAll(),
    });
    isListening = listener.isListening;
    stopListening = listener.stop;
  }

  // Set by startLoops(); the closer below references it lazily so it's safe to call even
  // if startLoops() was never invoked.
  let stopDispatcher: (() => Promise<void>) | undefined;

  return {
    app,
    port: parsed.PORT,
    tenantId: tenant.tenantId,
    timeZone: tenant.timeZone,
    workers: {
      dispatch: () => dispatchOnce({ db, subscribers }),
    },
    startLoops() {
      stopDispatcher = startDispatcher({ db, subscribers });
    },
    attach: hub ? (server: Server) => hub.attach(server) : undefined,
    closeBeforeServer: hub ? [{ name: "updates hub", close: () => hub.close() }] : [],
    closers: [
      ...(stopListening ? [{ name: "LISTEN connection", close: stopListening }] : []),
      { name: "event dispatcher", close: async () => { await stopDispatcher?.(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
