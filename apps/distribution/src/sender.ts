import { and, eq, inArray, sql } from "drizzle-orm";
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
  /** The "stop claiming more rows" threshold: a run stops once `now >= lockUntil -
   * lockMarginMs`. Defaults to `perMessageMs` — the same worst-case-per-message bound used to
   * size the default lock — so a run never starts a message it might not finish before its own
   * lock could, in the worst realistic case (every timeout hit), expire. Must be smaller than
   * the resolved `lockMs`, or every claimed row would be abandoned without ever being sent;
   * sendDue/startSender reject that combination immediately. */
  lockMarginMs?: number;
  /** Checked before every message; once it returns true, sendDue stops starting new sends and
   * returns (rows not yet reached stay claimed until their lock expires). Set by
   * `startSender`'s stop() so an in-flight run winds down after its current message instead of
   * being torn down mid-send. */
  stopRequested?: () => boolean;
  /** R1: how long `transport.verify()` is given, on a config-class error, to decide whether the
   * SMTP server itself is reachable before concluding the *message* is to blame. Defaults to
   * {@link DEFAULT_VERIFY_TIMEOUT_MS}. */
  verifyTimeoutMs?: number;
  /** R1(b) backstop: a message still pending after this long is marked failed and logged no
   * matter what kind of error it's been hitting — the net under every other retry/defer path,
   * so nothing can stay pending forever. Measured from its batch's `created_at` (messages have
   * no creation timestamp of their own; every message in a batch is created at the same
   * instant). Defaults to {@link DEFAULT_MAX_MESSAGE_AGE_MS}. */
  maxMessageAgeMs?: number;
}

const DEFAULT_BATCH_SIZE = 50;
// Mirrors packages/events/src/dispatcher.ts's LOCK_MARGIN_MS: extra slack baked into the
// *size* of the default lock, on top of the worst-case processing time. Distinct from
// lockMarginMs (the loop's "stop claiming more rows" threshold, below), which is sized off
// perMessageMs instead — a fixed 30s margin would be irrelevant for a short lock and overkill
// for a long one.
const LOCK_MARGIN_MS = 30_000;
// Matches env.ts's SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS
// defaults (10s + 10s + 30s): the worst-case time nodemailer lets a single message's send take
// before its own timeouts abort it, used when the caller doesn't say otherwise.
const DEFAULT_PER_MESSAGE_MS = 10_000 + 10_000 + 30_000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;
const MAX_ERROR_CODE_POINTS = 500;
// R1: default budget for transport.verify() to answer "is the server itself reachable" before
// a config-class error is attributed to the message instead.
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;
// R1(b): the backstop — a message pending longer than this is marked failed regardless of
// error class, so nothing (a permanently-down server, a poison message misclassified forever,
// anything) can keep a message pending indefinitely.
const DEFAULT_MAX_MESSAGE_AGE_MS = 24 * 3_600_000;

/**
 * A send involves real network I/O (SMTP round-trips) per message in the batch, processed
 * sequentially, so the claim must outlive the worst case of every message in the batch hitting
 * its full per-message timeout — otherwise another replica reclaims rows mid-batch and sends
 * them a second time. Mirrors packages/events/src/dispatcher.ts's defaultLockMs.
 */
export function defaultSendLockMs(opts: { batchSize: number; perMessageMs: number }): number {
  return opts.batchSize * opts.perMessageMs + LOCK_MARGIN_MS;
}

/**
 * Resolves the lock duration and stop-margin a call will use, and rejects a combination where
 * the margin would swallow the lock whole — if `lockMs <= lockMarginMs`, the very first
 * per-message check below would always fire before any row is ever sent, silently turning the
 * run into a no-op that just claims and abandons its whole batch forever.
 */
function resolveLock(opts: { batchSize: number; perMessageMs: number; lockMs?: number; lockMarginMs?: number }): { lockMs: number; lockMarginMs: number } {
  const lockMarginMs = opts.lockMarginMs ?? opts.perMessageMs;
  const lockMs = opts.lockMs ?? defaultSendLockMs({ batchSize: opts.batchSize, perMessageMs: opts.perMessageMs });
  if (lockMs <= lockMarginMs) {
    throw new Error(`sendDue: lockMs (${lockMs}) must be greater than lockMarginMs (${lockMarginMs}) — otherwise no claimed row would ever be sent`);
  }
  return { lockMs, lockMarginMs };
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

/** R1(a): the connection/greeting/STARTTLS stage is genuinely ambiguous by command alone —
 * nodemailer tags both "the server is down" and "this one message stalled/reset mid-DATA
 * against an otherwise-healthy server" (a poison message) as `command: "CONN"` (and EHLO
 * stalls similarly at the greeting stage). `transport.verify()` discriminates those two cases
 * — see isTransportHealthy. */
const CONNECTION_LEVEL_COMMANDS = new Set(["CONN", "EHLO", "HELO", "LHLO", "STARTTLS"]);

function isConnectionLevelError(e: unknown): boolean {
  const command = (e as { command?: unknown } | null)?.command;
  return typeof command === "string" && CONNECTION_LEVEL_COMMANDS.has(command);
}

/**
 * R24: unlike a connection-level error, a MAIL FROM or AUTH* failure is *never* ambiguous —
 * the envelope sender (`opts.from`) and the transport's configured credentials are the same
 * for every message a given `sendDue` call sends, so a rejection at either stage can't be
 * specific to whichever message happened to be claimed first. It's a server/config error by
 * construction, every time, with no need (and no safe way — see isTransportHealthy's own
 * known gap: verify() only attempts AUTH when the transport is configured with credentials, so
 * a transport with none at all can't have "needs auth but none configured" exercised by
 * verify()) to ask `transport.verify()` first.
 */
function isSenderLevelError(e: unknown): boolean {
  const command = (e as { command?: unknown } | null)?.command;
  return command === "MAIL FROM" || (typeof command === "string" && command.startsWith("AUTH"));
}

type ClaimedRow = {
  id: string;
  email: string;
  substitutions: Record<string, string> | null;
  attempts: number;
  deferrals: number;
  priority: number;
  next_attempt_at: Date;
  subject: string | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  // R1(b): messages have no creation timestamp of their own; every message in a batch is
  // created at the same instant as its batch, so this is the age backstop's clock.
  batch_created_at: Date;
};

/**
 * R1: discriminates "the SMTP server/config is actually unreachable" from "this one message is
 * poison" (e.g. a relay that stalls or resets mid-DATA — nodemailer tags that `command: "CONN"`,
 * indistinguishable by command alone from a real outage). A hung `verify()` is itself treated
 * as "unhealthy" (the safer default: a server that can't even answer a lightweight check within
 * budget is not one we should trust from a message-targeted content).
 */
async function isTransportHealthy(transport: Transporter, timeoutMs: number): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`transport.verify() timed out after ${timeoutMs}ms`)), timeoutMs);
      transport.verify().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Releases the lock on rows this call claimed but never got to (or no longer owns), so they're
 * immediately claimable by another run instead of sitting locked for up to the full lock
 * duration (tens of minutes at the default batch size). Ownership-guarded like every terminal
 * write: a row whose lock was already stolen by someone else simply won't match and is left
 * alone.
 */
async function releaseUnreachedRows(db: Db, ids: string[], lockUntil: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(messages)
    .set({ lockedUntil: null })
    .where(and(inArray(messages.id, ids), eq(messages.lockedUntil, lockUntil), eq(messages.status, "pending")));
}

export async function sendDue(opts: SendOptions): Promise<{ sent: number; retried: number; failed: number }> {
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perMessageMs = opts.perMessageMs ?? DEFAULT_PER_MESSAGE_MS;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const maxMessageAgeMs = opts.maxMessageAgeMs ?? DEFAULT_MAX_MESSAGE_AGE_MS;
  const { lockMs, lockMarginMs } = resolveLock({ batchSize, perMessageMs, lockMs: opts.lockMs, lockMarginMs: opts.lockMarginMs });
  const lockUntil = new Date(now.getTime() + lockMs);
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
    RETURNING m.id, m.email, m.substitutions, m.attempts, m.deferrals, m.priority, m.next_attempt_at, b.subject, b.html, b.text, b.headers, b.created_at AS batch_created_at`);

  const rows = claimed.rows.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const byDueTime = new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime();
    if (byDueTime !== 0) return byDueTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const result = { sent: 0, retried: 0, failed: 0 };
  let loggedConfigError = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    // Give up on any rows not yet reached rather than risk still being mid-send when this
    // call's own lock expires — lockMarginMs matches the worst-case time a message can take.
    if (opts.stopRequested?.() || clock().getTime() >= lockUntil.getTime() - lockMarginMs) {
      await releaseUnreachedRows(opts.db, rows.slice(i).map((r) => r.id), lockUntil);
      break;
    }

    // Re-assert ownership right before using it: a near-no-op UPDATE (rewriting the same
    // value) that fails to match if another worker's claim already reclaimed this row because
    // this call's lock had expired. Cheaper than a second SELECT FOR UPDATE, and closes the
    // window between the batch claim above and this particular row's turn to send. Losing a
    // row this way means another worker is already active on this batch, so the rest of this
    // call's claim is abandoned (and released) too rather than racing it row by row.
    const stillOwned = await opts.db.execute<{ id: string }>(sql`
      UPDATE messages SET locked_until = locked_until
       WHERE id = ${row.id} AND locked_until = ${lockUntil} AND status = 'pending'
      RETURNING id`);
    if (stillOwned.rows.length === 0) {
      await releaseUnreachedRows(opts.db, rows.slice(i + 1).map((r) => r.id), lockUntil);
      break;
    }

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
    let senderLevel = false;
    let connectionLevel = false;
    try {
      await opts.transport.sendMail({ from: opts.from, to, subject, html, text, headers });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      permanent = isPermanentRecipientRejection(e);
      senderLevel = !permanent && isSenderLevelError(e);
      connectionLevel = !permanent && !senderLevel && isConnectionLevelError(e);
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

    const lastError = truncateError(error);

    // R1(b) backstop: whatever error class this is, a message that's been pending this long
    // is marked failed and logged — the net under every other path below, so nothing (a
    // server down forever, a message misclassified forever) can keep a message pending past
    // this.
    const age = finishedAt.getTime() - new Date(row.batch_created_at).getTime();
    if (age >= maxMessageAgeMs) {
      const attempts = row.attempts + 1;
      const res = await opts.db.update(messages).set({ status: "failed", attempts, lockedUntil: null, lastError, originalRecipient }).where(where);
      if (res.rowCount) {
        result.failed++;
        console.error(`[distribution] message ${row.id} failed after ${attempts} attempts (pending ${Math.round(age / 3_600_000)}h, over the age backstop): ${error}`);
      }
      continue;
    }

    // R24: a sender-level error (MAIL FROM, AUTH*) is a server/config problem unconditionally
    // — see isSenderLevelError's doc comment — so it's deferred immediately, with no
    // transport.verify() round trip at all (and none of verify()'s own blind spots: a
    // misconfigured-but-no-credentials transport would otherwise verify "healthy" and this
    // would be misclassified as the message's fault, which is exactly the I2 drain coming
    // back for that specific misconfiguration).
    if (senderLevel) {
      const deferrals = row.deferrals + 1;
      const res = await opts.db
        .update(messages)
        .set({ deferrals, nextAttemptAt: new Date(finishedAt.getTime() + backoffMs(deferrals)), lockedUntil: null, lastError, originalRecipient })
        .where(where);
      if (res.rowCount) {
        result.retried++;
        if (!loggedConfigError) {
          loggedConfigError = true;
          console.error(`[distribution] SMTP server unavailable/misconfigured: ${error}`);
        }
      }
      await releaseUnreachedRows(opts.db, rows.slice(i + 1).map((r) => r.id), lockUntil);
      break;
    }

    // I2/R1(a): a connection-level error (`CONN`, `EHLO`/`HELO`/`LHLO`, `STARTTLS`) is
    // ambiguous by command alone — nodemailer tags both "the server is genuinely down" AND
    // "this message stalled/reset mid-DATA against an otherwise-healthy server" (a poison
    // message) the same way (`command: "CONN"`). `transport.verify()` discriminates: if the
    // server itself can't answer a lightweight check, it's an outage — defer every remaining
    // claimed row without spending an attempt (so an outage can never drain the queue to
    // failed) and stop this run. If the server verifies healthy, this specific message is to
    // blame: treat it exactly like a normal transient error (spends an attempt, standard
    // backoff, eventually fails and is logged) and keep going — unlike an outage, one poison
    // message must never stop the rest of the batch from sending.
    if (connectionLevel) {
      const serverHealthy = await isTransportHealthy(opts.transport, verifyTimeoutMs);
      if (!serverHealthy) {
        const deferrals = row.deferrals + 1;
        const res = await opts.db
          .update(messages)
          .set({ deferrals, nextAttemptAt: new Date(finishedAt.getTime() + backoffMs(deferrals)), lockedUntil: null, lastError, originalRecipient })
          .where(where);
        if (res.rowCount) {
          result.retried++;
          if (!loggedConfigError) {
            loggedConfigError = true;
            console.error(`[distribution] SMTP server unavailable/misconfigured: ${error}`);
          }
        }
        await releaseUnreachedRows(opts.db, rows.slice(i + 1).map((r) => r.id), lockUntil);
        break;
      }
      // Falls through to the normal transient-error handling below (attempts+1, standard
      // backoff, fails after MAX_ATTEMPTS), logging distinctly so this is recognisable as the
      // "poison message, not an outage" case.
      console.error(`[distribution] message ${row.id} transient error: ${error}`);
    }

    const attempts = row.attempts + 1;
    if (permanent || attempts >= MAX_ATTEMPTS) {
      const res = await opts.db.update(messages).set({ status: "failed", attempts, lockedUntil: null, lastError, originalRecipient }).where(where);
      // I5: a message going failed is otherwise silent — logged once, only when this call
      // actually made the write (the ownership-guarded `where` matched).
      if (res.rowCount) {
        result.failed++;
        console.error(`[distribution] message ${row.id} failed after ${attempts} attempts: ${error}`);
      }
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
  // Validated eagerly, at call time: a misconfigured lockMs/lockMarginMs would otherwise only
  // surface once the first tick fires, inside the interval's own catch — logged and silently
  // retried forever rather than failing the process fast and loudly at startup.
  resolveLock({ batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE, perMessageMs: opts.perMessageMs ?? DEFAULT_PER_MESSAGE_MS, lockMs: opts.lockMs, lockMarginMs: opts.lockMarginMs });

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
