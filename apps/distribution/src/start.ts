import nodemailer from "nodemailer";
import express from "express";
import { authFromEnv } from "@gcpe/auth";
import { parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createApp } from "./app";
import { distributionEnvSchema } from "./env";
import { sendDue, startSender } from "./sender";
import { smtpTransportOptions } from "./transport";

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
  /** Closers that must run *before* the http server closes. Distribution has none — always
   * empty — but the field exists on every app's AppHandle so main.ts (and the stack) can
   * build the shutdown order uniformly: `[...closeBeforeServer, httpServer, ...closers]`,
   * with no app-specific special-casing. */
  closeBeforeServer: Closer[];
  /** The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). */
  closers: Closer[];
}

/**
 * Wires up everything Distribution's main.ts needs: parses env, runs migrations, builds the
 * pooled SMTP transport and the Express app, and the pieces behind its sender loop.
 * Identical behaviour to the former main.ts, including the non-prod mail redirect log lines.
 */
export async function startDistribution(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(distributionEnvSchema, env);
  const auth = authFromEnv(env);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);

  const transport = nodemailer.createTransport(smtpTransportOptions(parsed));

  // The non-prod mail redirect safety rule: distributionEnvSchema already refuses to boot
  // without one of these, so exactly one of the two logs below always fires.
  if (parsed.MAIL_REDIRECT_TO.length > 0) {
    console.log(`[distribution] mail redirect ON → ${parsed.MAIL_REDIRECT_TO.join(", ")}`);
  } else {
    console.warn("[distribution] WARNING: delivering to real recipients");
  }

  const sendOptions = {
    db,
    transport,
    from: parsed.MAIL_FROM,
    messageIdDomain: parsed.MESSAGE_ID_DOMAIN,
    replyTo: parsed.MAIL_REPLY_TO,
    redirectTo: parsed.MAIL_REDIRECT_TO,
    perMessageMs: parsed.SMTP_CONNECTION_TIMEOUT_MS + parsed.SMTP_GREETING_TIMEOUT_MS + parsed.SMTP_SOCKET_TIMEOUT_MS,
    verifyTimeoutMs: parsed.SMTP_VERIFY_TIMEOUT_MS,
    maxMessageAgeMs: parsed.MAIL_MAX_AGE_MS,
  };

  const app = createApp({
    db,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
    internalDomains: parsed.INTERNAL_DOMAINS,
  });

  // Set by startLoops(); the closer below references it lazily so it's safe to call even if
  // startLoops() was never invoked.
  let stopSender: (() => Promise<void>) | undefined;

  return {
    app,
    port: parsed.PORT,
    workers: {
      send: () => sendDue(sendOptions),
    },
    startLoops() {
      stopSender = startSender({
        ...sendOptions,
        intervalMs: parsed.SEND_INTERVAL_MS,
        outageCooldownMaxMs: parsed.SEND_OUTAGE_COOLDOWN_MAX_MS,
      });
    },
    closeBeforeServer: [],
    closers: [
      { name: "sender", close: async () => { await stopSender?.(); } },
      { name: "transport", close: () => transport.close() },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
