import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { EventEnvelope } from "./envelope";
import { signPayload } from "./signing";
import type { SubscriberConfig } from "./subscribers";
import { outboxDeliveries } from "./tables";

export interface DispatchOptions {
  db: Db;
  subscribers: SubscriberConfig[];
  fetchImpl?: typeof fetch;
  /** Clock override for tests; defaults to the wall clock. */
  now?: () => Date;
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
  created_at: Date;
};

export async function dispatchOnce(opts: DispatchOptions): Promise<{ delivered: number; retried: number; dead: number }> {
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const lockUntil = new Date(now.getTime() + (opts.lockMs ?? defaultLockMs(opts)));
  const maxAgeMs = opts.maxAgeMs ?? 24 * 3_600_000;
  const doFetch = opts.fetchImpl ?? fetch;

  // Phase 1: claim (short transaction, no network I/O while holding row locks).
  const claimed = await opts.db.execute<ClaimedRow>(sql`
    UPDATE outbox_deliveries d
       SET locked_until = ${lockUntil}
      FROM outbox_events e
     WHERE e.id = d.event_id
       AND (d.event_id, d.subscriber) IN (
             SELECT event_id, subscriber FROM outbox_deliveries
              WHERE status = 'pending'
                AND next_attempt_at < ${new Date(now.getTime() + 1)}
                AND (locked_until IS NULL OR locked_until < ${now})
              ORDER BY next_attempt_at
              LIMIT ${opts.batchSize ?? DEFAULT_BATCH_SIZE}
              FOR UPDATE SKIP LOCKED)
    RETURNING d.event_id, d.subscriber, d.attempts, e.envelope, e.created_at`);

  const result = { delivered: 0, retried: 0, dead: 0 };
  for (const row of claimed.rows) {
    // The lockUntil this call's claim set is this row's ownership token: a terminal
    // write only counts if we still held the lock (status unchanged, locked_until
    // still ours) at write time. If another replica reclaimed the row in between
    // (its lock expired mid-delivery), this update affects 0 rows and we defer to
    // whatever that replica writes instead of overwriting it.
    const where = and(
      eq(outboxDeliveries.eventId, row.event_id),
      eq(outboxDeliveries.subscriber, row.subscriber),
      eq(outboxDeliveries.status, "pending"),
      eq(outboxDeliveries.lockedUntil, lockUntil),
    );
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

    // Stamp results with the time the attempt finished, not the batch's claim time:
    // late rows in a slow batch would otherwise get a backoff that has already elapsed.
    const finishedAt = clock();
    const attempts = row.attempts + 1;
    if (error === null) {
      const res = await opts.db
        .update(outboxDeliveries)
        .set({ status: "delivered", attempts, deliveredAt: finishedAt, lockedUntil: null, lastError: null })
        .where(where);
      if (res.rowCount) result.delivered++;
    } else if (finishedAt.getTime() - new Date(row.created_at).getTime() >= maxAgeMs) {
      const res = await opts.db.update(outboxDeliveries).set({ status: "dead", attempts, lockedUntil: null, lastError: error }).where(where);
      if (res.rowCount) result.dead++;
    } else {
      const res = await opts.db
        .update(outboxDeliveries)
        .set({ attempts, nextAttemptAt: new Date(finishedAt.getTime() + backoffMs(attempts)), lockedUntil: null, lastError: error })
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
      .catch((e) => console.error("[events] dispatch failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 1000);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
