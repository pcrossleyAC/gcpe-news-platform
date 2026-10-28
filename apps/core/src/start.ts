import { fileURLToPath } from "node:url";
import { z } from "zod";
import express from "express";
import { authFromEnv } from "@gcpe/auth";
import { parseEnv } from "@gcpe/config";
import { safeErrorLabel, type Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";
import { createEntraClient } from "./entra/client";
import { signInSettingsFromEnv } from "./entra/config";
import { republishAll } from "./services/republish";
import { publishDueCabinetChanges } from "./services/cabinet-changes";

export const coreEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3001),
  EVENT_SUBSCRIBERS: z.string().optional(),
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
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

  const app = createApp({
    db,
    subscribers,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
    session: auth.session
      ? {
          secret: auth.session.secret,
          secure: parsed.SESSION_COOKIE_SECURE,
          local: auth.local,
          entra: signIn.entra ? createEntraClient(signIn.entra) : null,
          userPasswordsAllowed: signIn.userPasswordsAllowed,
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
    ],
  };
}
