import { fileURLToPath } from "node:url";
import { z } from "zod";
import express from "express";
import { authFromEnv } from "@gcpe/auth";
import { assertTimeZoneRules, loadTenantConfig, parseEnv, trustProxyHopsFrom } from "@gcpe/config";
import { safeErrorLabel, type Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, outboxAdmin, parseSubscribers, startDispatcher, type OutboxAdmin, type UndeliveredUpdate } from "@gcpe/events";
import { recentDismissals, recordDismissals, type Dismissal } from "./services/outbox-dismissals";
import type { SessionGate } from "@gcpe/auth";
import { createApp } from "./app";
import { sessionCheckDb, sessionGate as coreSessionGate } from "./services/sessions";
import { createEntraClient } from "./entra/client";
import { signInSettingsFromEnv } from "./entra/config";
import { republishAll } from "./services/republish";
import { adminEmails } from "./services/users";
import { publishDueCabinetChanges } from "./services/cabinet-changes";

export const coreEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3001),
  EVENT_SUBSCRIBERS: z.string().optional(),
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** The tenant file: its time zone turns a cabinet change's BC schedule time into an instant (NG-R15). */
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
  /** This app's outbox: its undelivered updates and backlog, for the stack's Undelivered updates
   * screen and `/stack/health` (suite review O1/O2). */
  outbox: OutboxAdmin;
  /** Who dismissed which undelivered update of any app's outbox (services/outbox-dismissals.ts). */
  outboxDismissals: {
    record(app: string, updates: UndeliveredUpdate[], actor: { id: string; name: string }): Promise<void>;
    recent(limit: number): Promise<Dismissal[]>;
  };
  /** Core's session gate: the stack installs it for every app in its process (setSessionGate),
   * so a deactivation or sign-out is refused on the very next request anywhere. */
  sessionGate: SessionGate;
  /** Starts the interval loops exactly as main.ts does today. */
  startLoops(): void;
  /** Closers that must run *before* the http server closes. Core has none — always empty —
   * but the field exists on every app's AppHandle so main.ts (and the stack) can build the
   * shutdown order uniformly: `[...closeBeforeServer, httpServer, ...closers]`, with no
   * app-specific special-casing. */
  closeBeforeServer: Closer[];
  /** The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). */
  closers: Closer[];
}

/**
 * Wires up everything Core's main.ts needs: parses env, runs migrations, builds the Express
 * app and the pieces behind its background loop. Identical behaviour to the former main.ts —
 * same env vars/defaults, same migrations-at-startup, same logs — just split so main.ts and
 * (later) a single-process stack can share this wiring.
 */
export async function startCore(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(coreEnvSchema, env);
  const auth = authFromEnv(env);
  const signIn = signInSettingsFromEnv(env);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);
  const subscribers = parseSubscribers(parsed.EVENT_SUBSCRIBERS);
  // Fail fast when this runtime's tzdata disagrees with the tenant's pinned self-check, as NRMS and the News API do.
  const tenant = loadTenantConfig(parsed.TENANT_CONFIG);
  assertTimeZoneRules(tenant);

  // Production configuration T5 (2026-10-31): with break-glass off and Microsoft sign-in on, an
  // active Core Admin with an email is the only way in to manage users. Without one, say so
  // loudly; never refuse to start, which would take the public site down too.
  if (auth.local === null && signIn.entra && (await adminEmails(db)).length === 0) {
    console.warn(
      "[core] NO ADMIN: no active Core Admin can sign in with Microsoft (none has an email), and the break-glass admin is off: nobody can manage users. Turn break-glass on to add one (docs/deploy/windows.md, P4).",
    );
  }

  // Its own small pool with short timeouts (review S I1): every app's cookie requests use it.
  const check = sessionCheckDb(parsed.DATABASE_URL);
  const sessionGate = coreSessionGate(check.db, { localConfigured: auth.local !== null, secret: auth.session?.secret ?? "" });
  const app = createApp({
    sessionGate,
    trustProxyHops: trustProxyHopsFrom(env),
    db,
    subscribers,
    timeZone: tenant.timeZone,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
    session: auth.session
      ? {
          secret: auth.session.secret,
          secure: parsed.SESSION_COOKIE_SECURE,
          local: auth.local,
          entra: signIn.entra ? createEntraClient(signIn.entra) : null,
          userPasswordsAllowed: signIn.userPasswordsAllowed,
          maxSessionSeconds: auth.session.maxSessionSeconds,
        }
      : undefined,
  });

  // Set by startLoops(); closers below reference it lazily so they're safe to call even if
  // startLoops() was never invoked (e.g. a test that only exercises `workers`/`closers`).
  let stopDispatcher: (() => Promise<void>) | undefined;
  let cabinetLoop: NodeJS.Timeout | undefined;

  return {
    app,
    port: parsed.PORT,
    sessionGate,
    outbox: outboxAdmin(db),
    outboxDismissals: {
      record: (app, updates, actor) => recordDismissals(db, app, updates, actor),
      recent: (limit) => recentDismissals(db, limit),
    },
    workers: {
      dispatch: () => dispatchOnce({ db, subscribers }),
      // Phase 4a: lets the stack ask Core to re-emit every org/term as an upserted event — the
      // one-time reference-data backfill for a NoD that has never seen them (stack.ts).
      republish: () => republishAll(db, subscribers),
      // New-government spec §5: publishes a staged cabinet change once its scheduled time has come
      // (the stack's core.cabinet-changes tick step; the loop below when Core runs on its own).
      cabinetChanges: () => publishDueCabinetChanges(db, subscribers),
    },
    startLoops() {
      stopDispatcher = startDispatcher({ db, subscribers });
      // Skips a beat while the previous run is still going, so a long publish never stacks up runs
      // that hold pool connections waiting on its lock.
      let busy = false;
      cabinetLoop = setInterval(() => {
        if (busy) return;
        busy = true;
        void publishDueCabinetChanges(db, subscribers)
          .catch((e) => console.error("[core] scheduled cabinet change failed", safeErrorLabel(e)))
          .finally(() => {
            busy = false;
          });
      }, 30_000);
      cabinetLoop.unref();
    },
    closeBeforeServer: [],
    closers: [
      { name: "event dispatcher", close: async () => { await stopDispatcher?.(); } },
      { name: "cabinet change scheduler", close: async () => clearInterval(cabinetLoop) },
      { name: "db pool", close: () => pool.end() },
      { name: "session check pool", close: () => check.pool.end() },
    ],
  };
}
