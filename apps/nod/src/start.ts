import { fileURLToPath } from "node:url";
import { z } from "zod";
import express from "express";
import { authFromEnv } from "@gcpe/auth";
import { eventSecretsSchema, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import type { Closer } from "@gcpe/http-kit";
import { createApp } from "./app";
import { distributionClient } from "./distribution-client";
import { distributionTokenProvider } from "./distribution-token";
import { needsReferenceData } from "./lists";
import { sendDueJobs, startJobSender } from "./send-jobs";

export const nodEnvSchema = z.object({
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
  // Phase 4a: HMAC key for unsubscribe tokens (the stack derives it from STACK_EVENT_SECRET).
  LINK_SECRET: z.string().min(32),
  // The page emailed verify/manage links open. Default: the public site's test page.
  SUBSCRIBE_PAGE_URL: z.string().url().optional(),
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
  /** Closers that must run *before* the http server closes. NoD has none — always empty —
   * but the field exists on every app's AppHandle so main.ts (and the stack) can build the
   * shutdown order uniformly: `[...closeBeforeServer, httpServer, ...closers]`, with no
   * app-specific special-casing. */
  closeBeforeServer: Closer[];
  /** The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). */
  closers: Closer[];
}

/**
 * Wires up everything NoD's main.ts needs: parses env, runs migrations, builds the
 * Distribution client/token provider and the Express app, and the pieces behind its job
 * sender loop. Identical behaviour to the former main.ts.
 */
export async function startNod(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(nodEnvSchema, env);
  const auth = authFromEnv(env);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);

  const getDistributionToken = distributionTokenProvider({
    tokenUrl: parsed.DISTRIBUTION_TOKEN_URL,
    clientId: parsed.DISTRIBUTION_CLIENT_ID,
    clientSecret: parsed.DISTRIBUTION_CLIENT_SECRET,
    scope: parsed.DISTRIBUTION_SCOPE,
    local: auth.local,
  });
  const distribution = distributionClient({
    baseUrl: parsed.DISTRIBUTION_URL,
    getToken: getDistributionToken,
    timeoutMs: parsed.DISTRIBUTION_TIMEOUT_MS,
  });

  const sendJobsOptions = { db, distribution, manageUrl: parsed.MANAGE_URL, perChunkMs: parsed.DISTRIBUTION_TIMEOUT_MS };

  const app = createApp({
    db,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
    eventSecrets: parsed.EVENT_SECRETS,
    handlerOptions: { publicSiteUrl: parsed.PUBLIC_SITE_URL, manageUrl: parsed.MANAGE_URL },
    subscribe: {
      db,
      distribution,
      pageUrl: parsed.SUBSCRIBE_PAGE_URL ?? `${parsed.PUBLIC_SITE_URL.replace(/\/$/, "")}/subscribe/manage/`,
      linkSecret: parsed.LINK_SECRET,
    },
  });

  // Set by startLoops(); the closer below references it lazily so it's safe to call even if
  // startLoops() was never invoked.
  let stopJobSender: (() => Promise<void>) | undefined;

  return {
    app,
    port: parsed.PORT,
    workers: {
      send: () => sendDueJobs(sendJobsOptions),
      // Phase 4a: lets the stack (stack.ts) check, once at startup, whether Core's reference
      // data has ever reached this NoD so it knows whether to ask Core to republish.
      needsReferenceData: () => needsReferenceData(db),
    },
    startLoops() {
      stopJobSender = startJobSender(sendJobsOptions);
    },
    closeBeforeServer: [],
    closers: [
      { name: "job sender", close: async () => { await stopJobSender?.(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
