import type { DistributionEnv } from "./env";

type SmtpEnv = Pick<
  DistributionEnv,
  | "SMTP_HOST"
  | "SMTP_PORT"
  | "SMTP_SECURE"
  | "SMTP_USER"
  | "SMTP_PASS"
  | "SMTP_TLS_REJECT_UNAUTHORIZED"
  | "SMTP_CONNECTION_TIMEOUT_MS"
  | "SMTP_GREETING_TIMEOUT_MS"
  | "SMTP_SOCKET_TIMEOUT_MS"
  | "SMTP_MAX_CONNECTIONS"
>;

/** nodemailer transport options for Distribution's sender (see main.ts). */
export function smtpTransportOptions(env: SmtpEnv) {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    tls: { rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED },
    // Explicit timeouts bound how long a single message's send can take, which is what makes
    // sender.ts's claim lock (batchSize * (perMessageMs + verifyTimeoutMs)) a real upper bound
    // instead of a guess — without them a hung connection can outlive the lock and get
    // double-sent.
    connectionTimeout: env.SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: env.SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: env.SMTP_SOCKET_TIMEOUT_MS,
    // Up to MAIL_CONCURRENCY sends are in flight at once (sendDue's bounded pool); pooling
    // reuses connections across them instead of reconnecting per message.
    pool: true as const,
    maxConnections: env.SMTP_MAX_CONNECTIONS,
    // P2-R25 item 4: no pool-level re-queue. nodemailer (10.0.14, smtp-pool/index.js
    // _requeueEntryOnConnectionClose) re-queues a message whose connection closes while it's
    // assigned — up to maxRequeues (default 5) times, with up to 2s backoff between, inside one
    // sendMail() call. In this version that only happens for a close before the server's
    // greeting (verified: a close at EHLO/RCPT/DATA or after the final "." is reported as a
    // CONN error, not re-queued), so it can't deliver a message twice today — but it can make
    // one sendMail take ~6x perMessageMs, outliving the claim lock that perMessageMs sizes,
    // and it would silently re-send if a future version re-queued at a later stage. With 0,
    // sendMail fails on the first close and sender.ts's own classification and backoff decide
    // what happens next.
    maxRequeues: 0,
  };
}
