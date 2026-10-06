import { fileURLToPath } from "node:url";
import { z } from "zod";
import express from "express";
import { authFromEnv } from "@gcpe/auth";
import { parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";

export const coreEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3001),
  EVENT_SUBSCRIBERS: z.string().optional(),
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
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
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);
  const subscribers = parseSubscribers(parsed.EVENT_SUBSCRIBERS);

  const app = createApp({
    db,
    subscribers,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
  });

  // Set by startLoops(); closers below reference it lazily so they're safe to call even if
  // startLoops() was never invoked (e.g. a test that only exercises `workers`/`closers`).
  let stopDispatcher: (() => Promise<void>) | undefined;

  return {
    app,
    port: parsed.PORT,
    workers: {
      dispatch: () => dispatchOnce({ db, subscribers }),
    },
    startLoops() {
      stopDispatcher = startDispatcher({ db, subscribers });
    },
    closeBeforeServer: [],
    closers: [
      { name: "event dispatcher", close: async () => { await stopDispatcher?.(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
