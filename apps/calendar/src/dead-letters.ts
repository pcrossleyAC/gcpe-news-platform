import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { listUndelivered, retryUndelivered } from "@gcpe/events";
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

/**
 * The Calendar's deliveries the dispatcher gave up on (24 hours of retries). The payload is never
 * shown. Reads through the shared undelivered-updates list (packages/events undelivered.ts, which
 * the Hub's Undelivered updates screen also uses), adding the activity's reference where this
 * viewer may see the activity.
 */
export async function listDeadLetters(db: Db, timeZone: string, viewer: Viewer, limit = DEAD_LETTER_LIMIT): Promise<DeadLetterList> {
  const list = await listUndelivered(db, limit);
  const activityId = (aggregateId: string) => {
    const m = /^activity:(\d+)$/.exec(aggregateId);
    return m ? Number(m[1]) : null;
  };
  const ids = [...new Set(list.items.map((r) => activityId(r.aggregateId)).filter((id): id is number => id !== null && Number.isSafeInteger(id)))];
  const seen = ids.length
    ? await db.select({ id: activities.id, abbreviation: orgs.abbreviation }).from(activities).leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey)).where(and(inArray(activities.id, ids), visibleSql(viewer)))
    : [];
  const reference = new Map(seen.map((a) => [a.id, `${a.abbreviation ?? "?"}-${a.id}`]));
  const items = list.items.map((r) => {
    const w = wallClock(new Date(r.createdAt), timeZone);
    const id = activityId(r.aggregateId);
    return {
      eventId: r.eventId,
      subscriber: r.subscriber,
      type: r.type,
      aggregateId: r.aggregateId,
      activityReference: (id !== null && reference.get(id)) || null,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt,
      queuedAtBc: `${w.date} ${w.time}`,
    };
  });
  return { items, truncated: list.truncated };
}

/**
 * Puts one dead delivery back in the queue: the next dispatch tries it once more. The event is
 * already past the dispatcher's 24 hours, so a failure makes it dead again straight away.
 */
export const retryDeadLetter = (db: Db, eventId: string, subscriber: string): Promise<boolean> => retryUndelivered(db, eventId, subscriber);
