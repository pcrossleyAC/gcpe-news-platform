import { and, eq, inArray, sql } from "drizzle-orm";
import { ageMsOf, heldBy, lockTokenOf, ownedPending, sqlInterval, sqlNow, sqlNowPlus, stopwatch, type Db, type LockToken, type TestClock } from "@gcpe/db-kit";
import type { Transporter } from "nodemailer";
import { batches, messages, type StoredAttachment } from "./db/schema";
import { substitute } from "./substitute";

export interface SendOptions {
  db: Db;
  transport: Transporter;
  from: string;
  /** The domain of every outgoing message's Message-ID (see {@link messageIdFor}) — env.ts's
   * MESSAGE_ID_DOMAIN, already resolved (an explicit value, or MAIL_FROM's own domain).
   * Defaults to {@link DEFAULT_MESSAGE_ID_DOMAIN} when omitted; start.ts always supplies env.ts's
   * resolved value, which fails startup rather than ever falling through to that default. */
  messageIdDomain?: string;
  /** Used when a message's own batch carries no Reply-To (messages.ts's replyTo) — env.ts's
   * MAIL_REPLY_TO. Undefined means no Reply-To header at all. Redirect mode leaves this
   * unchanged, same as the Message-ID. */
  replyTo?: string;
  /** Non-empty in every non-prod environment: every message is sent here instead of its real
   * recipient (the non-prod mail redirect safety rule). Empty only when an operator has
   * explicitly opted in to real delivery (enforced at the env layer, not here). */
  redirectTo: string[];
  /** Test hook: when given, its value stands in for SQL `now()` in every statement this call
   * makes (claim, lock, backoff, sent_at, age). Production omits it and the database's clock is
   * used throughout — see {@link sendDue}. */
  now?: TestClock;
  /** C58/spec §6: the database-enforced per-minute send cap, shared across every worker
   * through the `send_rate_windows` table — a worker may claim at most `ratePerMinute` minus
   * what's already been claimed this minute, counted whether or not a claimed row's send
   * succeeds. Defaults to {@link DEFAULT_RATE_PER_MINUTE} when omitted; start.ts always supplies
   * env.ts's own `MAIL_RATE_PER_MINUTE` (minimum 1). */
  ratePerMinute?: number;
  batchSize?: number;
  /** Worst-case time a single message's *send* can take: the sum of the transport's
   * connection, greeting and socket timeouts. Together with `verifyTimeoutMs` (a
   * connection-level error is followed by a transport.verify() of up to that long) it sizes the
   * default claim lock (see {@link defaultSendLockMs}) so a batch that hits every timeout still
   * finishes inside its own lock. Defaults to {@link DEFAULT_PER_MESSAGE_MS} (the env defaults'
   * sum) when omitted. */
  perMessageMs?: number;
  lockMs?: number;
  /** The "stop claiming more rows" threshold: a run stops once the time elapsed since its claim
   * reaches `lockMs - lockMarginMs`. Defaults to `perMessageMs + verifyTimeoutMs` — the same
   * worst-case-per-message bound (send, then verify) used to size the default lock — so a run
   * never starts a message it might not finish before its own lock could, in the worst realistic
   * case (every timeout hit, then a verify that times out too), expire. Must be smaller than
   * the resolved `lockMs`, or every claimed row would be abandoned without ever being sent;
   * sendDue/startSender reject that combination immediately. */
  lockMarginMs?: number;
  /** Checked before every message; once it returns true, sendDue stops starting new sends and
   * returns, releasing the lock on rows it hadn't reached yet so another run can claim them
   * at once (see releaseUnreachedRows). Set by
   * `startSender`'s stop() so an in-flight run winds down after its current message instead of
   * being torn down mid-send. */
  stopRequested?: () => boolean;
  /** R1: how long `transport.verify()` is given, on a config-class error, to decide whether the
   * SMTP server itself is reachable before concluding the *message* is to blame. Part of each
   * message's worst case, so it is counted in the default lock and stop margin. Defaults to
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
// Only reached when a caller omits ratePerMinute (mainly tests exercising something else);
// start.ts always supplies env.ts's own resolved MAIL_RATE_PER_MINUTE in production.
const DEFAULT_RATE_PER_MINUTE = 60;
// How long window rows are kept before the opportunistic cleanup removes them — generous
// enough that nothing but very old rows is ever touched.
const RATE_WINDOW_RETENTION_MS = 24 * 3_600_000;
// Only reached when a caller omits messageIdDomain (mainly tests exercising something else);
// start.ts always supplies env.ts's own resolved MESSAGE_ID_DOMAIN in production.
const DEFAULT_MESSAGE_ID_DOMAIN = "localhost";
// Mirrors packages/events/src/dispatcher.ts's LOCK_MARGIN_MS: extra slack baked into the
// *size* of the default lock, on top of the worst-case processing time. Distinct from
// lockMarginMs (the loop's "stop claiming more rows" threshold, below), which is sized off one
// message's worst case (perMessageMs + verifyTimeoutMs) instead — a fixed 30s margin would be
// irrelevant for a short lock and overkill for a long one.
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
// P2-R27 item 2: the longest the sender pauses after an outage deferral, whatever that row's
// own (escalating, up to 1h) backoff — bounds recovery latency once the server is back.
export const DEFAULT_OUTAGE_COOLDOWN_MAX_MS = 300_000;
// R1(b): the backstop — a message pending longer than this is marked failed regardless of
// error class, so nothing (a permanently-down server, a poison message misclassified forever,
// anything) can keep a message pending indefinitely.
const DEFAULT_MAX_MESSAGE_AGE_MS = 24 * 3_600_000;

/**
 * A send involves real network I/O (SMTP round-trips) per message in the batch, processed
 * sequentially, so the claim must outlive the worst case of every message in the batch hitting
 * its full per-message timeout *and then* a transport.verify() timing out too (a
 * connection-level error is followed by one, per message — see isTransportHealthy) — otherwise
 * another replica reclaims rows mid-batch and sends them a second time. Mirrors
 * packages/events/src/dispatcher.ts's defaultLockMs.
 */
export function defaultSendLockMs(opts: { batchSize: number; perMessageMs: number; verifyTimeoutMs: number }): number {
  return opts.batchSize * (opts.perMessageMs + opts.verifyTimeoutMs) + LOCK_MARGIN_MS;
}

/**
 * Resolves the lock duration and stop-margin a call will use, and rejects a combination where
 * the margin would swallow the lock whole — if `lockMs <= lockMarginMs`, the very first
 * per-message check below would always fire before any row is ever sent, silently turning the
 * run into a no-op that just claims and abandons its whole batch forever.
 */
function resolveLock(opts: { batchSize: number; perMessageMs: number; verifyTimeoutMs: number; lockMs?: number; lockMarginMs?: number }): {
  lockMs: number;
  lockMarginMs: number;
} {
  const lockMarginMs = opts.lockMarginMs ?? opts.perMessageMs + opts.verifyTimeoutMs;
  const lockMs = opts.lockMs ?? defaultSendLockMs({ batchSize: opts.batchSize, perMessageMs: opts.perMessageMs, verifyTimeoutMs: opts.verifyTimeoutMs });
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
 * A message's Message-ID, derived from its own row id (stable across every retry of the same
 * message — no randomness, nothing to lose between attempts) and the configured domain
 * (env.ts's MESSAGE_ID_DOMAIN). Exported so 4e's bounce matching can derive the same value from
 * a bounce report's own In-Reply-To/References.
 */
export function messageIdFor(rowId: string, domain: string): string {
  return `<${rowId}@${domain}>`;
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
  if (typeof command === "string") return CONNECTION_LEVEL_COMMANDS.has(command);
  return isDroppedBeforeSend(e);
}

/**
 * P2-R25 item 4 / P2-R27 item 3: with the pool's re-queue off (transport.ts maxRequeues: 0), a
 * connection closed before the server's greeting (or a pool that was closed) fails sendMail
 * with code ECONNECTION and no `command` at all. Nothing of the message reached the server, so
 * it can never be the message's fault: verify() decides only between "server down" (an outage,
 * as for any connection-level error) and "server up but flapping" (deferred without spending an
 * attempt — see sendDue).
 */
function isDroppedBeforeSend(e: unknown): boolean {
  const err = e as { command?: unknown; code?: unknown } | null;
  return err?.command === undefined && err?.code === "ECONNECTION";
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
  batch_id: string;
  /** Whether the batch carries attachments — they're loaded once per batch (see
   * loadAttachments), not returned by the claim, which would repeat up to 7 MiB per row. */
  has_attachments: boolean;
  email: string;
  substitutions: Record<string, string> | null;
  attempts: number;
  deferrals: number;
  priority: number;
  /** Raw timestamptz text from the driver; only used to order the claimed rows for sending. */
  next_attempt_at: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  reply_to: string | null;
  // R1(b): messages have no creation timestamp of their own; every message in a batch is
  // created at the same instant as its batch, so the batch's age (at claim time, by the
  // database's clock) is the age backstop's clock.
  batch_age_ms: number;
  /** The exact locked_until this claim wrote — the ownership token (the same for every row of
   * one claim: a statement's now() is constant). */
  lock_token: LockToken;
};

type MailAttachment = { filename: string; content: Buffer; contentType: StoredAttachment["contentType"] };

async function loadAttachments(db: Db, batchId: string): Promise<MailAttachment[]> {
  const [row] = await db.select({ attachments: batches.attachments }).from(batches).where(eq(batches.id, batchId));
  return (row?.attachments ?? []).map((a) => ({ filename: a.filename, content: Buffer.from(a.contentBase64, "base64"), contentType: a.contentType }));
}

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
async function releaseUnreachedRows(db: Db, ids: string[], lockToken: LockToken): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(messages)
    .set({ lockedUntil: null })
    .where(and(inArray(messages.id, ids), ownedPending(messages, lockToken)));
}

/**
 * Clock (P2-R22 D1): every comparison and stamp uses the database's clock — the claim's due
 * and lock predicates use `now()`, the lock is `now() + lockMs` and its exact value is returned
 * as the ownership token, backoffs and `sent_at` are computed from `now()` at the terminal
 * write, and a message's age is its batch's age at claim time (computed in SQL) plus the
 * monotonic time elapsed since. The stop-margin check is likewise monotonic: a stopwatch
 * started just before the claim is sent can only over-estimate time since the database
 * evaluated the claim's `now()`, so "elapsed >= lockMs - lockMarginMs" stops no later than the
 * DB-clock deadline would — with no wall-clock JS Date ever compared to a DB timestamp, and no
 * extra round trip per message. `opts.now`, a test hook, replaces SQL `now()` with its value in
 * every statement this call makes.
 */
export async function sendDue(opts: SendOptions): Promise<SendResult> {
  return (await runSend(opts)).result;
}

type SendResult = { sent: number; retried: number; failed: number; rateLimited: boolean };

/** sendDue's body, also reporting (for startSender's outage pacing) the backoff given to a row
 * deferred because the SMTP server/config itself was unavailable, if this run hit one. */
async function runSend(opts: SendOptions): Promise<{ result: SendResult; outageBackoffMs?: number }> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perMessageMs = opts.perMessageMs ?? DEFAULT_PER_MESSAGE_MS;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const maxMessageAgeMs = opts.maxMessageAgeMs ?? DEFAULT_MAX_MESSAGE_AGE_MS;
  const ratePerMinute = opts.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE;
  const { lockMs, lockMarginMs } = resolveLock({ batchSize, perMessageMs, verifyTimeoutMs, lockMs: opts.lockMs, lockMarginMs: opts.lockMarginMs });
  const redirect = opts.redirectTo.length > 0;

  // Phase 1: claim, inside one explicit transaction — the rate-window row's lock and the
  // claimed message rows' locks are taken and released together, and nothing here does any
  // network I/O, so the transaction is always short-lived and commits before any sendMail; the
  // send loop below runs entirely after this transaction returns.
  //
  // C58/spec §6: the window row (today's minute, `date_trunc('minute', now())`) is locked with
  // `SELECT ... FOR UPDATE` *before* the message claim below takes its own row locks — the same
  // order every caller uses, so two concurrent sendDue calls simply serialise on the window row
  // (the second blocks for the few milliseconds the first's transaction takes, then sees its
  // committed `claimed` count) rather than risk a deadlock from acquiring locks in different
  // orders. `budget` is how many more rows this minute may still claim; the claim's own LIMIT is
  // whichever of `batchSize` or `budget` is smaller, and `claimed` is incremented by exactly how
  // many rows were actually claimed (never a full `batchSize`'s worth if fewer were due) — a
  // claimed row counts against the minute whether or not its send later succeeds.
  const sinceClaim = stopwatch();
  const now = sqlNow(opts.now);
  const windowStart = sql`date_trunc('minute', ${now})`;
  const { rows: claimedRows, rateLimited } = await opts.db.transaction(async (tx) => {
    // Opportunistic cleanup: one row per minute ever claimed from, keyed by its own primary
    // key, so deleting everything older than a day is cheap even though it runs on every claim.
    await tx.execute(sql`DELETE FROM send_rate_windows WHERE window_start < ${now} - ${sqlInterval(RATE_WINDOW_RETENTION_MS)}`);

    await tx.execute(sql`INSERT INTO send_rate_windows (window_start) VALUES (${windowStart}) ON CONFLICT DO NOTHING`);
    const { rows: windowRows } = await tx.execute<{ claimed: number }>(
      sql`SELECT claimed FROM send_rate_windows WHERE window_start = ${windowStart} FOR UPDATE`,
    );
    // Defensive: the INSERT just above, in this same transaction, guarantees this row exists by
    // the time this SELECT runs, and nothing else in this transaction can have removed it since
    // — so this should be unreachable. Falling back to a default of 0 instead of throwing would
    // hand out a full, unbounded budget and then silently fail to record it (the increment
    // below would match no rows), bypassing the cap rather than merely miscounting it.
    if (windowRows.length === 0) {
      throw new Error(`sendDue: send_rate_windows row for ${windowStart} is missing right after its own INSERT`);
    }
    const claimedThisMinute = windowRows[0]!.claimed;
    const budget = ratePerMinute - claimedThisMinute;
    if (budget <= 0) return { rows: [] as ClaimedRow[], rateLimited: true };

    // The `due` CTE picks the rows in priority order under FOR UPDATE SKIP LOCKED; the outer
    // UPDATE joins batches for the template content so the claim and the read happen in one
    // round trip. Postgres doesn't promise UPDATE...RETURNING preserves the CTE's row order, so
    // priority/next_attempt_at are returned too and the claimed rows are re-sorted in JS below
    // before they're sent.
    const claimed = await tx.execute<ClaimedRow>(sql`
      WITH due AS (
        SELECT id FROM messages
         WHERE status = 'pending'
           AND next_attempt_at <= ${now}
           AND (locked_until IS NULL OR locked_until < ${now})
         ORDER BY priority DESC, next_attempt_at, id
         LIMIT ${Math.min(batchSize, budget)}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE messages m
         SET locked_until = ${now} + ${sqlInterval(lockMs)}
        FROM batches b, due
       WHERE b.id = m.batch_id AND m.id = due.id
      RETURNING m.id, m.batch_id, jsonb_array_length(b.attachments) > 0 AS has_attachments, m.email, m.substitutions, m.attempts, m.deferrals, m.priority, m.next_attempt_at,
                b.subject, b.html, b.text, b.headers, b.reply_to, ${ageMsOf(sql`b.created_at`, now)} AS batch_age_ms, ${lockTokenOf(sql`m.locked_until`)} AS lock_token`);

    // True only when the cap — not batchSize, and not simply running out of due rows — is what
    // actually bound this claim: the budget was smaller than batchSize *and* every bit of it
    // was used. A budget that's merely smaller than batchSize but idle (fewer rows were due
    // than the remaining budget) must report false: "exhausted before batchSize" means
    // exhausted, not just smaller.
    const rateLimited = budget < batchSize && claimed.rows.length === budget;

    if (claimed.rows.length > 0) {
      const inc = await tx.execute(sql`UPDATE send_rate_windows SET claimed = claimed + ${claimed.rows.length} WHERE window_start = ${windowStart}`);
      // Same defensive reasoning as above: if this row were gone by now, the increment would
      // silently match nothing and the next claimer would see yesterday's (too-low) count.
      if (inc.rowCount !== 1) {
        throw new Error(`sendDue: send_rate_windows row for ${windowStart} vanished mid-claim — the rate cap would otherwise be silently bypassed`);
      }
    }
    return { rows: claimed.rows, rateLimited };
  });

  const rows = claimedRows.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const byDueTime = new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime();
    if (byDueTime !== 0) return byDueTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const lockToken = rows[0]?.lock_token ?? "";

  // Per run, per batch: every message of a batch carries the same attachments.
  const attachmentsByBatch = new Map<string, Promise<MailAttachment[]>>();
  const attachmentsFor = (row: ClaimedRow): Promise<MailAttachment[]> => {
    if (!row.has_attachments) return Promise.resolve([]);
    let loaded = attachmentsByBatch.get(row.batch_id);
    if (!loaded) {
      loaded = loadAttachments(opts.db, row.batch_id);
      attachmentsByBatch.set(row.batch_id, loaded);
    }
    return loaded;
  };

  const result = { sent: 0, retried: 0, failed: 0, rateLimited };
  let outageBackoffMs: number | undefined;
  let loggedConfigError = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    // Give up on any rows not yet reached rather than risk still being mid-send when this
    // call's own lock expires — lockMarginMs matches the worst-case time a message can take
    // (its send, then a verify).
    if (opts.stopRequested?.() || sinceClaim() >= lockMs - lockMarginMs) {
      await releaseUnreachedRows(opts.db, rows.slice(i).map((r) => r.id), lockToken);
      break;
    }

    // Derived from the row's own id, so it's the same value on every attempt — the write
    // below records it, but a retry after a lost reply recomputes (not regenerates) it.
    const messageId = messageIdFor(row.id, opts.messageIdDomain ?? DEFAULT_MESSAGE_ID_DOMAIN);

    // Re-assert ownership right before using it: a near-no-op UPDATE (rewriting the same
    // locked_until, alongside this attempt's Message-ID) that fails to match if another
    // worker's claim already reclaimed this row because this call's lock had expired. Cheaper
    // than a second SELECT FOR UPDATE, and closes the window between the batch claim above and
    // this particular row's turn to send. Losing a row this way means another worker is already
    // active on this batch, so the rest of this call's claim is abandoned (and released) too
    // rather than racing it row by row.
    const stillOwned = await opts.db.execute<{ id: string }>(sql`
      UPDATE messages SET locked_until = locked_until, message_id = ${messageId}
       WHERE id = ${row.id} AND ${heldBy(messages.lockedUntil, lockToken)} AND status = 'pending'
      RETURNING id`);
    if (stillOwned.rows.length === 0) {
      await releaseUnreachedRows(opts.db, rows.slice(i + 1).map((r) => r.id), lockToken);
      break;
    }

    // The lock this call's claim set is this row's ownership token: a terminal write only
    // counts if we still held the lock (status unchanged, locked_until still ours) at write
    // time — mirrors packages/events/src/dispatcher.ts.
    const where = and(eq(messages.id, row.id), ownedPending(messages, lockToken));

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
    // Non-prod redirect: every copy lands in the same tester's inbox, so name the intended
    // recipient in the subject too — otherwise copies for different recipients look identical.
    const sentSubject = redirect ? `[to: ${row.email}] ${subject}` : subject;

    const to = redirect ? opts.redirectTo : [row.email];
    const attachments = await attachmentsFor(row);
    // The request's own Reply-To beats MAIL_REPLY_TO; neither set means no Reply-To header at
    // all. Unaffected by redirect mode, same as the Message-ID.
    const replyTo = row.reply_to ?? opts.replyTo ?? undefined;

    let error: string | null = null;
    let permanent = false;
    let senderLevel = false;
    let connectionLevel = false;
    let droppedBeforeSend = false;
    try {
      await opts.transport.sendMail({ from: opts.from, to, subject: sentSubject, html, text, headers, attachments, messageId, replyTo });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      permanent = isPermanentRecipientRejection(e);
      senderLevel = !permanent && isSenderLevelError(e);
      connectionLevel = !permanent && !senderLevel && isConnectionLevelError(e);
      droppedBeforeSend = connectionLevel && isDroppedBeforeSend(e);
    }

    const originalRecipient = redirect ? row.email : null;
    if (error === null) {
      const res = await opts.db
        .update(messages)
        .set({ status: "sent", sentAt: sqlNow(opts.now), lockedUntil: null, lastError: null, originalRecipient })
        .where(where);
      if (res.rowCount) result.sent++;
      continue;
    }

    const lastError = truncateError(error);

    // R1(b) backstop: whatever error class this is, a message that's been pending this long
    // is marked failed and logged — the net under every other path below, so nothing (a
    // server down forever, a message misclassified forever) can keep a message pending past
    // this.
    const age = Number(row.batch_age_ms) + sinceClaim();
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
      outageBackoffMs = backoffMs(deferrals);
      const res = await opts.db
        .update(messages)
        .set({ deferrals, nextAttemptAt: sqlNowPlus(backoffMs(deferrals), opts.now), lockedUntil: null, lastError, originalRecipient })
        .where(where);
      if (res.rowCount) {
        result.retried++;
        if (!loggedConfigError) {
          loggedConfigError = true;
          console.error(`[distribution] SMTP server unavailable/misconfigured: ${error}`);
        }
      }
      await releaseUnreachedRows(opts.db, rows.slice(i + 1).map((r) => r.id), lockToken);
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
        outageBackoffMs = backoffMs(deferrals);
        const res = await opts.db
          .update(messages)
          .set({ deferrals, nextAttemptAt: sqlNowPlus(backoffMs(deferrals), opts.now), lockedUntil: null, lastError, originalRecipient })
          .where(where);
        if (res.rowCount) {
          result.retried++;
          if (!loggedConfigError) {
            loggedConfigError = true;
            console.error(`[distribution] SMTP server unavailable/misconfigured: ${error}`);
          }
        }
        await releaseUnreachedRows(opts.db, rows.slice(i + 1).map((r) => r.id), lockToken);
        break;
      }
      // P2-R27 item 3: a flapping server — the connection dropped before anything of this
      // message was sent, yet the server verifies healthy. Not the message's fault, so no
      // attempt is spent: deferred with its own escalating backoff (the age backstop above
      // bounds it), and — the server being up — the run carries on with the next row.
      if (droppedBeforeSend) {
        const deferrals = row.deferrals + 1;
        const res = await opts.db
          .update(messages)
          .set({ deferrals, nextAttemptAt: sqlNowPlus(backoffMs(deferrals), opts.now), lockedUntil: null, lastError, originalRecipient })
          .where(where);
        if (res.rowCount) {
          result.retried++;
          console.error(`[distribution] message ${row.id} deferred: connection dropped before sending, server verifies healthy: ${error}`);
        }
        continue;
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
        .set({ attempts, nextAttemptAt: sqlNowPlus(backoffMs(attempts), opts.now), lockedUntil: null, lastError, originalRecipient })
        .where(where);
      if (res.rowCount) result.retried++;
    }
  }
  return { result, outageBackoffMs };
}

/**
 * Runs sendDue every `intervalMs`, one run at a time.
 *
 * P2-R25 item 3, outage pacing: a run that defers a row because the SMTP server/config itself
 * is unavailable stops and releases the rest of its claim — so without pacing, the next tick
 * would claim the next row and hit the still-down server again, every tick, for the length of
 * the outage. Instead, the sender then skips ticks for that row's deferral backoff, capped at
 * `outageCooldownMaxMs` (default {@link DEFAULT_OUTAGE_COOLDOWN_MAX_MS}, 5 min) so that once the
 * server is back, sending resumes within that cap plus one interval even after a long outage
 * (an in-memory cooldown, per process). `cooldownClock` (monotonic ms, default
 * `performance.now`) is a test hook.
 */
export function startSender(opts: SendOptions & { intervalMs?: number; outageCooldownMaxMs?: number; cooldownClock?: () => number }): () => Promise<void> {
  // Validated eagerly, at call time: a misconfigured lockMs/lockMarginMs would otherwise only
  // surface once the first tick fires, inside the interval's own catch — logged and silently
  // retried forever rather than failing the process fast and loudly at startup.
  resolveLock({
    batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
    perMessageMs: opts.perMessageMs ?? DEFAULT_PER_MESSAGE_MS,
    verifyTimeoutMs: opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    lockMs: opts.lockMs,
    lockMarginMs: opts.lockMarginMs,
  });

  const monotonicNow = opts.cooldownClock ?? (() => performance.now());
  const cooldownMaxMs = opts.outageCooldownMaxMs ?? DEFAULT_OUTAGE_COOLDOWN_MAX_MS;
  let stopped = false;
  let running: Promise<unknown> | null = null;
  let cooldownUntil = 0;
  const sendOpts: SendOptions = { ...opts, stopRequested: () => stopped };
  const timer = setInterval(() => {
    if (stopped || running || monotonicNow() < cooldownUntil) return;
    running = runSend(sendOpts)
      .then(({ outageBackoffMs }) => {
        if (outageBackoffMs === undefined) {
          // Defensive: ticks are skipped while a cooldown is active, so by the time a run gets
          // here any earlier cooldown has already expired — clearing it is a no-op today, kept
          // so a future early-run path (e.g. a manual "send now") can't inherit a stale pause.
          cooldownUntil = 0;
          return;
        }
        const pauseMs = Math.min(outageBackoffMs, cooldownMaxMs);
        cooldownUntil = monotonicNow() + pauseMs;
        console.warn(`[distribution] SMTP unavailable: pausing sends for ${Math.round(pauseMs / 1000)}s`);
      })
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
