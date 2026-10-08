import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents } from "@gcpe/events";
import { wallClock } from "./time";

export interface DeadLetter {
  eventId: string;
  subscriber: string;
  type: string;
  aggregateId: string;
  attempts: number;
  /** "HTTP 503" or a network error's own text; never the payload. */
  lastError: string | null;
  createdAt: string;
  /** When it was queued, as "YYYY-MM-DD HH:MM" in the tenant's time zone; a browser's tzdata can be stale. */
  queuedAtBc: string;
}

/** The Calendar's deliveries the dispatcher gave up on (24 hours of retries). The payload is never shown. */
export async function listDeadLetters(db: Db, timeZone: string, limit = 200): Promise<DeadLetter[]> {
  const rows = await db
    .select({ eventId: outboxDeliveries.eventId, subscriber: outboxDeliveries.subscriber, attempts: outboxDeliveries.attempts, lastError: outboxDeliveries.lastError, type: outboxEvents.type, aggregateId: outboxEvents.aggregateId, createdAt: outboxEvents.createdAt })
    .from(outboxDeliveries)
    .innerJoin(outboxEvents, eq(outboxEvents.id, outboxDeliveries.eventId))
    .where(eq(outboxDeliveries.status, "dead"))
    .orderBy(desc(outboxEvents.createdAt))
    .limit(limit);
  return rows.map((r) => {
    const w = wallClock(r.createdAt, timeZone);
    return { ...r, createdAt: r.createdAt.toISOString(), queuedAtBc: `${w.date} ${w.time}` };
  });
}

/**
 * Puts one dead delivery back in the queue: the next dispatch tries it once more. The event is
 * already past the dispatcher's 24 hours, so a failure makes it dead again straight away.
 */
export async function retryDeadLetter(db: Db, eventId: string, subscriber: string): Promise<boolean> {
  const r = await db
    .update(outboxDeliveries)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(0), lockedUntil: null, lastError: null })
    .where(and(eq(outboxDeliveries.eventId, eventId), eq(outboxDeliveries.subscriber, subscriber), eq(outboxDeliveries.status, "dead")));
  return (r.rowCount ?? 0) > 0;
}
