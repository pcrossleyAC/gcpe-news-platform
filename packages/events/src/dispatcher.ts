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
  now?: () => Date;
  batchSize?: number;
  maxAgeMs?: number;
  lockMs?: number;
  timeoutMs?: number;
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
  const now = (opts.now ?? (() => new Date()))();
  const lockUntil = new Date(now.getTime() + (opts.lockMs ?? 60_000));
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
                AND date_trunc('milliseconds', next_attempt_at) <= ${now}
                AND (locked_until IS NULL OR locked_until < ${now})
              ORDER BY next_attempt_at
              LIMIT ${opts.batchSize ?? 50}
              FOR UPDATE SKIP LOCKED)
    RETURNING d.event_id, d.subscriber, d.attempts, e.envelope, e.created_at`);

  const result = { delivered: 0, retried: 0, dead: 0 };
  for (const row of claimed.rows) {
    const where = and(eq(outboxDeliveries.eventId, row.event_id), eq(outboxDeliveries.subscriber, row.subscriber));
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
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    const attempts = row.attempts + 1;
    if (error === null) {
      await opts.db.update(outboxDeliveries).set({ status: "delivered", attempts, deliveredAt: now, lockedUntil: null, lastError: null }).where(where);
      result.delivered++;
    } else if (!sub || now.getTime() - new Date(row.created_at).getTime() >= maxAgeMs) {
      await opts.db.update(outboxDeliveries).set({ status: "dead", attempts, lockedUntil: null, lastError: error }).where(where);
      result.dead++;
    } else {
      await opts.db
        .update(outboxDeliveries)
        .set({ attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), lockedUntil: null, lastError: error })
        .where(where);
      result.retried++;
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
