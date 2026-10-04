import { fileURLToPath } from "node:url";
import { z } from "zod";
import express from "express";
import { authFromEnv } from "@gcpe/auth";
import { assertTimeZoneRules, eventSecretsSchema, loadTenantConfig, parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";
import { publishDue, startPublisher } from "./publisher";

export const nrmsEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3006),
  EVENT_SUBSCRIBERS: z.string().optional(),
  EVENT_SECRETS: eventSecretsSchema,
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  PUBLISH_INTERVAL_MS: z.coerce.number().int().default(60000),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
});

export interface AppHandle {
  app: express.Express;
  /** Parsed PORT (same env var/default as before) — main.ts listens on this; nothing new to
   * parse there. */
  port: number;
  /** One iteration of each background loop, using the same function and options the loop
   * itself uses. */
  workers: Record<string, () => Promise<unknown>>;
  /** Starts the interval loops exactly as main.ts does today. */
  startLoops(): void;
  /** Closers that must run *before* the http server closes. NRMS has none — always empty —
   * but the field exists on every app's AppHandle so main.ts (and the stack) can build the
   * shutdown order uniformly: `[...closeBeforeServer, httpServer, ...closers]`, with no
   * app-specific special-casing. */
  closeBeforeServer: Closer[];
  /** The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). */
  closers: Closer[];
}

/**
 * Wires up everything NRMS's main.ts needs: parses env, runs migrations, builds the Express
 * app and the pieces behind its two background loops (publisher, event dispatcher).
 * Identical behaviour to the former main.ts.
 */
export async function startNrms(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(nrmsEnvSchema, env);
  const auth = authFromEnv(env);
  // The tenant's time zone decides the BC year in approve-time Keys; fail fast if this
  // runtime's tzdata disagrees with the tenant's pinned self-check (as the News API does).
  const tenant = loadTenantConfig(parsed.TENANT_CONFIG);
  assertTimeZoneRules(tenant);
  const workflow = { timeZone: tenant.timeZone };
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);
  const subscribers = parseSubscribers(parsed.EVENT_SUBSCRIBERS);

  const app = createApp({
    db,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
    eventSecrets: parsed.EVENT_SECRETS,
    workflow,
  });

  // Set by startLoops(); closers below reference these lazily so they're safe to call even
  // if startLoops() was never invoked.
  let stopPublisher: (() => Promise<void>) | undefined;
  let stopDispatcher: (() => Promise<void>) | undefined;

  return {
    app,
    port: parsed.PORT,
    workers: {
      publish: () => publishDue({ db, subscribers }),
      dispatch: () => dispatchOnce({ db, subscribers }),
    },
    startLoops() {
      stopDispatcher = startDispatcher({ db, subscribers });
      stopPublisher = startPublisher({ db, subscribers, intervalMs: parsed.PUBLISH_INTERVAL_MS });
    },
    closeBeforeServer: [],
    closers: [
      { name: "publisher", close: async () => { await stopPublisher?.(); } },
      { name: "event dispatcher", close: async () => { await stopDispatcher?.(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
