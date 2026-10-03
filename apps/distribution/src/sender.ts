import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { Transporter } from "nodemailer";
import { messages } from "./db/schema";
import { substitute } from "./substitute";

export interface SendOptions {
  db: Db;
  transport: Transporter;
  from: string;
  /** Non-empty in every non-prod environment: every message is sent here instead of its real
   * recipient (the non-prod mail redirect safety rule). Empty only when an operator has
   * explicitly opted in to real delivery (enforced at the env layer, not here). */
  redirectTo: string[];
  /** Clock override for tests; defaults to the wall clock. */
  now?: () => Date;
  batchSize?: number;
  lockMs?: number;
}

const DEFAULT_BATCH_SIZE = 50;
// A send involves real network I/O (SMTP round-trips) per message in the batch, processed
// sequentially, so the claim must outlive the worst case of every message in the batch being
// slow — otherwise another replica reclaims rows mid-batch and sends them a second time.
const DEFAULT_LOCK_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;
const MAX_ERROR_LENGTH = 500;

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

function isPermanentSmtpError(e: unknown): boolean {
  const code = (e as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

type ClaimedRow = {
  id: string;
  email: string;
  substitutions: Record<string, string> | null;
  attempts: number;
  subject: string | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
};

export async function sendDue(opts: SendOptions): Promise<{ sent: number; retried: number; failed: number }> {
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const lockUntil = new Date(now.getTime() + (opts.lockMs ?? DEFAULT_LOCK_MS));
  const redirect = opts.redirectTo.length > 0;

  // Phase 1: claim (short transaction, no network I/O while holding row locks). Joins
  // batches for the template content so the claim and the read happen in one statement.
  const claimed = await opts.db.execute<ClaimedRow>(sql`
    UPDATE messages m
       SET locked_until = ${lockUntil}
      FROM batches b
     WHERE b.id = m.batch_id
       AND m.id IN (
             SELECT id FROM messages
              WHERE status = 'pending'
                AND next_attempt_at <= ${now}
                AND (locked_until IS NULL OR locked_until < ${now})
              ORDER BY priority DESC, next_attempt_at, id
              LIMIT ${batchSize}
              FOR UPDATE SKIP LOCKED)
    RETURNING m.id, m.email, m.substitutions, m.attempts, b.subject, b.html, b.text, b.headers`);

  const result = { sent: 0, retried: 0, failed: 0 };
  for (const row of claimed.rows) {
    // The lockUntil this call's claim set is this row's ownership token: a terminal write
    // only counts if we still held the lock (status unchanged, locked_until still ours) at
    // write time — mirrors packages/events/src/dispatcher.ts.
    const where = and(eq(messages.id, row.id), eq(messages.status, "pending"), eq(messages.lockedUntil, lockUntil));

    const values = row.substitutions ?? {};
    const subject = substitute(row.subject ?? "", values, "header");
    const html = substitute(row.html ?? "", values, "html");
    const text = row.text != null ? substitute(row.text, values, "text") : undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(row.headers ?? {})) headers[name] = substitute(value, values, "header");
    if (redirect) headers["X-Original-To"] = row.email;

    const to = redirect ? opts.redirectTo : [row.email];

    let error: string | null = null;
    let permanent = false;
    try {
      await opts.transport.sendMail({ from: opts.from, to, subject, html, text, headers });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      permanent = isPermanentSmtpError(e);
    }

    const finishedAt = clock();
    const originalRecipient = redirect ? row.email : null;
    if (error === null) {
      const res = await opts.db
        .update(messages)
        .set({ status: "sent", sentAt: finishedAt, lockedUntil: null, lastError: null, originalRecipient })
        .where(where);
      if (res.rowCount) result.sent++;
      continue;
    }

    const attempts = row.attempts + 1;
    const lastError = error.slice(0, MAX_ERROR_LENGTH);
    if (permanent || attempts >= MAX_ATTEMPTS) {
      const res = await opts.db.update(messages).set({ status: "failed", attempts, lockedUntil: null, lastError, originalRecipient }).where(where);
      if (res.rowCount) result.failed++;
    } else {
      const res = await opts.db
        .update(messages)
        .set({ attempts, nextAttemptAt: new Date(finishedAt.getTime() + backoffMs(attempts)), lockedUntil: null, lastError, originalRecipient })
        .where(where);
      if (res.rowCount) result.retried++;
    }
  }
  return result;
}

export function startSender(opts: SendOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = sendDue(opts)
      .catch((e) => console.error("[distribution] send failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 2000);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
