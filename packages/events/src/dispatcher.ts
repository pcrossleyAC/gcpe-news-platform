import { and, eq, sql } from "drizzle-orm";
import { ageMsOf, lockTokenOf, ownedPending, sqlInterval, sqlNow, sqlNowPlus, stopwatch, type Db, type LockToken, type TestClock } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { EventEnvelope } from "./envelope";
import { signPayload } from "./signing";
import type { SubscriberConfig } from "./subscribers";
import { outboxDeliveries } from "./tables";

export interface DispatchOptions {
  db: Db;
  subscribers: SubscriberConfig[];
  fetchImpl?: typeof fetch;
  /** Test hook: when given, its value stands in for SQL `now()` in every statement this call
   * makes (claim, lock, backoff, delivered_at, age). Production omits it and the database's
   * clock is used throughout — see {@link dispatchOnce}. */
  now?: TestClock;
  batchSize?: number;
  maxAgeMs?: number;
  /** How long a claim holds its rows. Defaults to {@link defaultLockMs}. */
  lockMs?: number;
  timeoutMs?: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const LOCK_MARGIN_MS = 30_000;

/**
 * Deliveries in a batch run sequentially, so the claim must outlive the worst case of
 * every delivery timing out; otherwise another replica reclaims rows mid-batch and
 * POSTs them a second time.
 */
export function defaultLockMs(opts: { batchSize?: number; timeoutMs?: number }): number {
  return (opts.batchSize ?? DEFAULT_BATCH_SIZE) * (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + LOCK_MARGIN_MS;
}

export function backoffMs(attempts: number): number {
  return Math.min(10_000 * 2 ** (attempts - 1), 3_600_000);
}

type ClaimedRow = {
  event_id: string;
  subscriber: string;
  attempts: number;
  envelope: EventEnvelope;
  /** The exact locked_until this claim wrote — the row's ownership token. */
  lock_token: LockToken;
  /** The event's age at claim time, by the database's clock. */
  age_ms: number;
};

/**
 * Clock (P2-R22 D1): every comparison and stamp uses the database's clock — the claim's due
 * and lock predicates use `now()`, the lock is `now() + lockMs` and its exact value is returned
 * as the ownership token, retry backoff and `delivered_at` are computed from `now()` at the
 * terminal write. The only JS-side time is a monotonic stopwatch started just before the claim
 * (to age a row at the end of a slow delivery). `opts.now`, a test hook, replaces SQL `now()`
 * with its value in every statement this call makes.
 */
export async function dispatchOnce(opts: DispatchOptions): Promise<{ delivered: number; retried: number; dead: number }> {
  const lockMs = opts.lockMs ?? defaultLockMs(opts);
  const maxAgeMs = opts.maxAgeMs ?? 24 * 3_600_000;
  const doFetch = opts.fetchImpl ?? fetch;

  // Phase 1: claim (short transaction, no network I/O while holding row locks).
  const sinceClaim = stopwatch();
  const now = sqlNow(opts.now);
  const claimed = await opts.db.execute<ClaimedRow>(sql`
    UPDATE outbox_deliveries d
       SET locked_until = ${now} + ${sqlInterval(lockMs)}
      FROM outbox_events e
     WHERE e.id = d.event_id
       AND (d.event_id, d.subscriber) IN (
             SELECT event_id, subscriber FROM outbox_deliveries
              WHERE status = 'pending'
                AND next_attempt_at <= ${now}
                AND (locked_until IS NULL OR locked_until < ${now})
              ORDER BY next_attempt_at
              LIMIT ${opts.batchSize ?? DEFAULT_BATCH_SIZE}
              FOR UPDATE SKIP LOCKED)
    RETURNING d.event_id, d.subscriber, d.attempts, e.envelope, ${lockTokenOf(sql`d.locked_until`)} AS lock_token, ${ageMsOf(sql`e.created_at`, now)} AS age_ms`);

  const result = { delivered: 0, retried: 0, dead: 0 };
  for (const row of claimed.rows) {
    // The lock this call's claim set is this row's ownership token: a terminal write only
    // counts if we still held the lock (status unchanged, locked_until still ours) at write
    // time. If another replica reclaimed the row in between (its lock expired
    // mid-delivery), this update affects 0 rows and we defer to whatever that replica
    // writes instead of overwriting it.
    const where = and(eq(outboxDeliveries.eventId, row.event_id), eq(outboxDeliveries.subscriber, row.subscriber), ownedPending(outboxDeliveries, row.lock_token));
    const sub = opts.subscribers.find((s) => s.name === row.subscriber);
    let error: string | null = null;
    if (!sub) {
      error = `subscriber ${row.subscriber} is not configured`;
    } else {
      const body = JSON.stringify(row.envelope);
      const timestamp = new Date().toISOString();
      try {
        const res = await doFetch(sub.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-event-id": row.envelope.id,
            "x-event-type": row.envelope.type,
            "x-event-source": row.envelope.source,
            "x-event-timestamp": timestamp,
            "x-signature": signPayload(sub.secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        await res.body?.cancel();
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    // Stamp results with the time the attempt finished (the terminal write's own now()), not
    // the batch's claim time: late rows in a slow batch would otherwise get a backoff that has
    // already elapsed.
    const attempts = row.attempts + 1;
    if (error === null) {
      const res = await opts.db
        .update(outboxDeliveries)
        .set({ status: "delivered", attempts, deliveredAt: sqlNow(opts.now), lockedUntil: null, lastError: null })
        .where(where);
      if (res.rowCount) result.delivered++;
    } else if (Number(row.age_ms) + sinceClaim() >= maxAgeMs) {
      const res = await opts.db.update(outboxDeliveries).set({ status: "dead", attempts, lockedUntil: null, lastError: error }).where(where);
      if (res.rowCount) result.dead++;
    } else {
      const res = await opts.db
        .update(outboxDeliveries)
        .set({ attempts, nextAttemptAt: sqlNowPlus(backoffMs(attempts), opts.now), lockedUntil: null, lastError: error })
        .where(where);
      if (res.rowCount) result.retried++;
    }
  }
  return result;
}

export function startDispatcher(opts: DispatchOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = dispatchOnce(opts)
      // Never `e` itself: a whole-run failure (e.g. the claim query itself erroring) can carry
      // a query error whose own message embeds bound values. A safe label is enough to triage.
      .catch((e) => console.error("[events] dispatch failed", safeErrorLabel(e)))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 1000);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
