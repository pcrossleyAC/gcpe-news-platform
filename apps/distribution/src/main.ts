import nodemailer from "nodemailer";
import { authFromEnv } from "@gcpe/auth";
import { parseEnv } from "@gcpe/config";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createApp } from "./app";
import { distributionEnvSchema } from "./env";
import { startSender } from "./sender";
import { smtpTransportOptions } from "./transport";

const env = parseEnv(distributionEnvSchema);

const auth = authFromEnv(process.env);
const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);

const transport = nodemailer.createTransport(smtpTransportOptions(env));

// The non-prod mail redirect safety rule: distributionEnvSchema already refuses to boot
// without one of these, so exactly one of the two logs below always fires.
if (env.MAIL_REDIRECT_TO.length > 0) {
  console.log(`[distribution] mail redirect ON → ${env.MAIL_REDIRECT_TO.join(", ")}`);
} else {
  console.warn("[distribution] WARNING: delivering to real recipients");
}

const stopSender = startSender({
  db,
  transport,
  from: env.MAIL_FROM,
  redirectTo: env.MAIL_REDIRECT_TO,
  intervalMs: env.SEND_INTERVAL_MS,
  perMessageMs: env.SMTP_CONNECTION_TIMEOUT_MS + env.SMTP_GREETING_TIMEOUT_MS + env.SMTP_SOCKET_TIMEOUT_MS,
  verifyTimeoutMs: env.SMTP_VERIFY_TIMEOUT_MS,
  maxMessageAgeMs: env.MAIL_MAX_AGE_MS,
});

const app = createApp({
  db,
  auth: auth.bearer,
  loginRouter: auth.loginRouter,
  internalDomains: env.INTERNAL_DOMAINS,
});
const server = app.listen(env.PORT, () => console.log(`[distribution] listening on ${env.PORT}`));

const shutdown = createShutdown({
  logPrefix: "[distribution]",
  exit: process.exit,
  closers: [
    { name: "http server", close: () => closeServer(server) },
    { name: "sender", close: stopSender },
    { name: "transport", close: () => transport.close() },
    { name: "db pool", close: () => pool.end() },
  ],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
