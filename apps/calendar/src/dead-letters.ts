import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents } from "@gcpe/events";
import { activities, orgs } from "./db/schema";
import { wallClock } from "./time";
import { visibleSql, type Viewer } from "./visibility";

export interface DeadLetter {
  eventId: string;
  subscriber: string;
  type: string;
  aggregateId: string;
  /** The activity's reference, such as HLTH-12, or null where the viewer can't see that activity (its ministry would show). */
  activityReference: string | null;
  attempts: number;
  /** "HTTP 503" or a network error's own text; never the payload. */
  lastError: string | null;
  createdAt: string;
  /** When it was queued, as "YYYY-MM-DD HH:MM" in the tenant's time zone; a browser's tzdata can be stale. */
  queuedAtBc: string;
}

export interface DeadLetterList {
  items: DeadLetter[];
  /** More dead deliveries exist than `items` holds: only the most recent are listed. */
  truncated: boolean;
}

/** How many dead deliveries the page lists, newest first. */
export const DEAD_LETTER_LIMIT = 200;

/** The Calendar's deliveries the dispatcher gave up on (24 hours of retries). The payload is never shown. */
export async function listDeadLetters(db: Db, timeZone: string, viewer: Viewer, limit = DEAD_LETTER_LIMIT): Promise<DeadLetterList> {
  const rows = await db
    .select({ eventId: outboxDeliveries.eventId, subscriber: outboxDeliveries.subscriber, attempts: outboxDeliveries.attempts, lastError: outboxDeliveries.lastError, type: outboxEvents.type, aggregateId: outboxEvents.aggregateId, createdAt: outboxEvents.createdAt })
    .from(outboxDeliveries)
    .innerJoin(outboxEvents, eq(outboxEvents.id, outboxDeliveries.eventId))
    .where(eq(outboxDeliveries.status, "dead"))
    .orderBy(desc(outboxEvents.createdAt))
    .limit(limit + 1);
  const listed = rows.slice(0, limit);
  const activityId = (aggregateId: string) => {
    const m = /^activity:(\d+)$/.exec(aggregateId);
    return m ? Number(m[1]) : null;
  };
  const ids = [...new Set(listed.map((r) => activityId(r.aggregateId)).filter((id): id is number => id !== null && Number.isSafeInteger(id)))];
  const seen = ids.length
    ? await db.select({ id: activities.id, abbreviation: orgs.abbreviation }).from(activities).leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey)).where(and(inArray(activities.id, ids), visibleSql(viewer)))
    : [];
  const reference = new Map(seen.map((a) => [a.id, `${a.abbreviation ?? "?"}-${a.id}`]));
  const items = listed.map((r) => {
    const w = wallClock(r.createdAt, timeZone);
    const id = activityId(r.aggregateId);
    return { ...r, activityReference: (id !== null && reference.get(id)) || null, createdAt: r.createdAt.toISOString(), queuedAtBc: `${w.date} ${w.time}` };
  });
  return { items, truncated: rows.length > limit };
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
