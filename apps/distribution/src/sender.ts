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
  /** Worst-case time a single message can take: the sum of the transport's connection,
   * greeting and socket timeouts. Used to size the default claim lock (see
   * {@link defaultSendLockMs}) so a batch that hits every timeout still finishes inside its
   * own lock. Defaults to {@link DEFAULT_PER_MESSAGE_MS} (the env defaults' sum) when omitted. */
  perMessageMs?: number;
  lockMs?: number;
  /** Checked before every message; once it returns true, sendDue stops starting new sends and
   * returns (rows not yet reached stay claimed until their lock expires). Set by
   * `startSender`'s stop() so an in-flight run winds down after its current message instead of
   * being torn down mid-send. */
  stopRequested?: () => boolean;
}

const DEFAULT_BATCH_SIZE = 50;
// Mirrors packages/events/src/dispatcher.ts's LOCK_MARGIN_MS: extra slack on top of the
// worst-case processing time, and — doubling as the "give up claimed-but-unstarted rows early"
// threshold below — the point past which a run stops starting new sends rather than risk still
// being mid-send when its lock expires and another worker reclaims the row.
const LOCK_MARGIN_MS = 30_000;
// Matches env.ts's SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS
// defaults (10s + 10s + 30s): the worst-case time nodemailer lets a single message's send take
// before its own timeouts abort it, used when the caller doesn't say otherwise.
const DEFAULT_PER_MESSAGE_MS = 10_000 + 10_000 + 30_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;
const MAX_ERROR_CODE_POINTS = 500;

/**
 * A send involves real network I/O (SMTP round-trips) per message in the batch, processed
 * sequentially, so the claim must outlive the worst case of every message in the batch hitting
 * its full per-message timeout — otherwise another replica reclaims rows mid-batch and sends
 * them a second time. Mirrors packages/events/src/dispatcher.ts's defaultLockMs.
 */
export function defaultSendLockMs(opts: { batchSize: number; perMessageMs: number }): number {
  return opts.batchSize * opts.perMessageMs + LOCK_MARGIN_MS;
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/**
 * Truncates by Unicode code point rather than UTF-16 code unit: `string.slice` counts UTF-16
 * units, so a message that happens to end mid-surrogate-pair at the 500-unit mark would be
 * stored with a dangling lone surrogate. Exported for its own unit test.
 */
export function truncateError(message: string, maxCodePoints = MAX_ERROR_CODE_POINTS): string {
  return Array.from(message).slice(0, maxCodePoints).join("");
}

/**
 * Permanent only for a recipient actually being rejected by the server (RCPT TO, or the
 * all-recipients-rejected error nodemailer raises when every recipient was rejected — both
 * carry `command: "RCPT TO"` and the latter also `rejected: string[]`). A 5xx response at any
 * other stage (AUTH, MAIL FROM, STARTTLS, the initial connection/greeting) is a configuration
 * problem, not proof the recipient is bad, so it must not drain the queue to `failed`.
 */
function isPermanentRecipientRejection(e: unknown): boolean {
  const err = e as { responseCode?: unknown; command?: unknown; rejected?: unknown } | null;
  const code = err?.responseCode;
  if (typeof code !== "number" || code < 500 || code >= 600) return false;
  return err?.command === "RCPT TO" || Array.isArray(err?.rejected);
}

const SMTP_CONFIG_ERROR_COMMANDS = new Set(["CONN", "MAIL FROM", "STARTTLS"]);

/** True for errors at the connection/greeting, authentication, sender, or STARTTLS stage —
 * i.e. everything nodemailer tags with a `command` other than a per-recipient one. These mean
 * the worker's own SMTP setup is wrong, not that any particular message is undeliverable. */
function isSmtpConfigError(e: unknown): boolean {
  const command = (e as { command?: unknown } | null)?.command;
  return typeof command === "string" && (SMTP_CONFIG_ERROR_COMMANDS.has(command) || command.startsWith("AUTH"));
}

type ClaimedRow = {
  id: string;
  email: string;
  substitutions: Record<string, string> | null;
  attempts: number;
  priority: number;
  next_attempt_at: Date;
  subject: string | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
};

export async function sendDue(opts: SendOptions): Promise<{ sent: number; retried: number; failed: number }> {
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perMessageMs = opts.perMessageMs ?? DEFAULT_PER_MESSAGE_MS;
  const lockUntil = new Date(now.getTime() + (opts.lockMs ?? defaultSendLockMs({ batchSize, perMessageMs })));
  const redirect = opts.redirectTo.length > 0;

  // Phase 1: claim (a single statement, no network I/O while holding row locks). The `due` CTE
  // picks the rows in priority order under FOR UPDATE SKIP LOCKED; the outer UPDATE joins
  // batches for the template content so the claim and the read happen in one round trip. Postgres
  // doesn't promise UPDATE...RETURNING preserves the CTE's row order, so priority/next_attempt_at
  // are returned too and the claimed rows are re-sorted in JS below before they're sent.
  const claimed = await opts.db.execute<ClaimedRow>(sql`
    WITH due AS (
      SELECT id FROM messages
       WHERE status = 'pending'
         AND next_attempt_at <= ${now}
         AND (locked_until IS NULL OR locked_until < ${now})
       ORDER BY priority DESC, next_attempt_at, id
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE messages m
       SET locked_until = ${lockUntil}
      FROM batches b, due
     WHERE b.id = m.batch_id AND m.id = due.id
    RETURNING m.id, m.email, m.substitutions, m.attempts, m.priority, m.next_attempt_at, b.subject, b.html, b.text, b.headers`);

  const rows = claimed.rows.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const byDueTime = new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime();
    if (byDueTime !== 0) return byDueTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const result = { sent: 0, retried: 0, failed: 0 };
  let loggedConfigError = false;
  for (const row of rows) {
    // Give up on any rows not yet reached rather than risk still being mid-send when this
    // call's own lock expires — the margin matches the slack baked into defaultSendLockMs.
    if (opts.stopRequested?.() || clock().getTime() >= lockUntil.getTime() - LOCK_MARGIN_MS) break;

    // Re-assert ownership right before using it: a near-no-op UPDATE (rewriting the same
    // value) that fails to match if another worker's claim already reclaimed this row because
    // this call's lock had expired. Cheaper than a second SELECT FOR UPDATE, and closes the
    // window between the batch claim above and this particular row's turn to send.
    const stillOwned = await opts.db.execute<{ id: string }>(sql`
      UPDATE messages SET locked_until = locked_until
       WHERE id = ${row.id} AND locked_until = ${lockUntil} AND status = 'pending'
      RETURNING id`);
    if (stillOwned.rows.length === 0) continue;

    // The lockUntil this call's claim set is this row's ownership token: a terminal write
    // only counts if we still held the lock (status unchanged, locked_until still ours) at
    // write time — mirrors packages/events/src/dispatcher.ts.
    const where = and(eq(messages.id, row.id), eq(messages.status, "pending"), eq(messages.lockedUntil, lockUntil));

    const values = row.substitutions ?? {};
    const subject = substitute(row.subject ?? "", values, "header");
    const html = substitute(row.html ?? "", values, "html");
    const text = row.text != null ? substitute(row.text, values, "text") : undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(row.headers ?? {})) {
      // Never let a caller-supplied header masquerade as ours: drop any variant of the name
      // before (maybe) setting our own below, case-insensitively, so exactly one survives.
      if (name.toLowerCase() === "x-original-to") continue;
      headers[name] = substitute(value, values, "header");
    }
    if (redirect) headers["X-Original-To"] = row.email;

    const to = redirect ? opts.redirectTo : [row.email];

    let error: string | null = null;
    let permanent = false;
    try {
      await opts.transport.sendMail({ from: opts.from, to, subject, html, text, headers });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      permanent = isPermanentRecipientRejection(e);
      if (!permanent && !loggedConfigError && isSmtpConfigError(e)) {
        loggedConfigError = true;
        console.error(`[distribution] SMTP configuration error: ${error}`);
      }
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
    const lastError = truncateError(error);
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
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const sendOpts: SendOptions = { ...opts, stopRequested: () => stopped };
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = sendDue(sendOpts)
      .catch((e) => console.error("[distribution] send failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 2000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
