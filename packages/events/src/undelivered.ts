import { and, desc, eq, sql } from "drizzle-orm";
import { sqlInterval, sqlNow, type Db, type TestClock } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents } from "./tables";

/**
 * Suite review O1 (owner 2026-10-31): the deliveries the dispatcher gave up on after 24 hours of
 * retries (`status = 'dead'`), for any app's outbox. Generalised from the Calendar's dead-letter
 * page (apps/calendar/src/dead-letters.ts), which now reads through this too. The payload is
 * never returned: only its type, which record it was about and the last error.
 */
export interface UndeliveredUpdate {
  eventId: string;
  /** The app that refused it, by its subscriber name (nod, news-api, nrms, calendar, …). */
  subscriber: string;
  type: string;
  aggregateId: string;
  /**
   * Which record it was about, in a word or two: a release's headline (or its key), an
   * organization's or term's key, a user's name, "Activity 12". Null when the event names none.
   * An activity's own title is never used: the Calendar decides who may see that.
   */
  about: string | null;
  attempts: number;
  /** "HTTP 503" or a network error's own text; never the payload. */
  lastError: string | null;
  /** When the event was queued (ISO). */
  createdAt: string;
}

export interface UndeliveredList {
  items: UndeliveredUpdate[];
  /** How many undelivered there are in all; more than `items` holds when the list is cut short. */
  total: number;
  truncated: boolean;
}

/** How many undelivered updates a list returns, newest first. */
export const UNDELIVERED_LIMIT = 200;

interface AboutFields {
  type: string;
  key: string | null;
  headline: string | null;
  displayName: string | null;
  activityId: string | null;
}

function aboutOf(r: AboutFields): string | null {
  if (r.type.startsWith("release.")) return r.headline || r.key;
  if (r.type.startsWith("activity.")) return r.activityId ? `Activity ${r.activityId}` : null;
  if (r.type === "user.upserted") return r.displayName;
  return r.key;
}

export async function listUndelivered(db: Db, limit = UNDELIVERED_LIMIT): Promise<UndeliveredList> {
  // Only the few fields "about" needs are read out of the envelope, never the whole of it.
  const data = sql`${outboxEvents.envelope} -> 'data'`;
  const rows = await db
    .select({
      eventId: outboxDeliveries.eventId,
      subscriber: outboxDeliveries.subscriber,
      attempts: outboxDeliveries.attempts,
      lastError: outboxDeliveries.lastError,
      type: outboxEvents.type,
      aggregateId: outboxEvents.aggregateId,
      createdAt: outboxEvents.createdAt,
      key: sql<string | null>`${data} ->> 'key'`,
      headline: sql<string | null>`${data} -> 'documents' -> 0 ->> 'headline'`,
      displayName: sql<string | null>`${data} ->> 'displayName'`,
      activityId: sql<string | null>`${data} ->> 'id'`,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxEvents, eq(outboxEvents.id, outboxDeliveries.eventId))
    .where(eq(outboxDeliveries.status, "dead"))
    .orderBy(desc(outboxEvents.createdAt), outboxDeliveries.eventId, outboxDeliveries.subscriber)
    .limit(limit + 1);
  const listed = rows.slice(0, limit);
  const total =
    rows.length > limit
      ? ((await db.select({ n: sql<number>`count(*)::int` }).from(outboxDeliveries).where(eq(outboxDeliveries.status, "dead")))[0]?.n ?? rows.length)
      : listed.length;
  return {
    items: listed.map((r) => ({
      eventId: r.eventId,
      subscriber: r.subscriber,
      type: r.type,
      aggregateId: r.aggregateId,
      about: aboutOf(r),
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    truncated: rows.length > limit,
  };
}

const requeue = { status: "pending", attempts: 0, nextAttemptAt: new Date(0), lockedUntil: null, lastError: null } as const;

/**
 * Puts one undelivered update back in the queue: the next dispatch tries it once more. The event
 * is already past the dispatcher's 24 hours, so a failure makes it undelivered again straight away.
 * False when there is no such undelivered update (already retried, or delivered meanwhile).
 */
export async function retryUndelivered(db: Db, eventId: string, subscriber: string): Promise<boolean> {
  const r = await db
    .update(outboxDeliveries)
    .set(requeue)
    .where(and(eq(outboxDeliveries.eventId, eventId), eq(outboxDeliveries.subscriber, subscriber), eq(outboxDeliveries.status, "dead")));
  return (r.rowCount ?? 0) > 0;
}

/** Puts every undelivered update in this outbox back in the queue; how many. */
export async function retryAllUndelivered(db: Db): Promise<number> {
  const r = await db.update(outboxDeliveries).set(requeue).where(eq(outboxDeliveries.status, "dead"));
  return r.rowCount ?? 0;
}

export interface OutboxHealth {
  /** Deliveries still waiting to go (including ones being retried). */
  pending: number;
  /** How long the oldest waiting delivery's event has waited, in whole minutes; null when none waits. */
  oldestPendingMinutes: number | null;
  /** Undelivered updates in all. */
  undelivered: number;
  /** Undelivered updates whose event was queued within `recentMs`. */
  recentUndelivered: number;
}

/** The outbox's backlog for `/stack/health` (suite review O2.1), by the database's clock. */
export async function outboxHealth(db: Db, opts: { recentMs: number; now?: TestClock }): Promise<OutboxHealth> {
  const now = sqlNow(opts.now);
  const { rows } = await db.execute<{ pending: number; oldest_minutes: number | null; undelivered: number; recent_undelivered: number }>(sql`
    SELECT count(*) FILTER (WHERE d.status = 'pending')::int AS pending,
           floor(extract(epoch from (${now} - min(e.created_at) FILTER (WHERE d.status = 'pending'))) / 60)::int AS oldest_minutes,
           count(*) FILTER (WHERE d.status = 'dead')::int AS undelivered,
           count(*) FILTER (WHERE d.status = 'dead' AND e.created_at > ${now} - ${sqlInterval(opts.recentMs)})::int AS recent_undelivered
      FROM outbox_deliveries d
      JOIN outbox_events e ON e.id = d.event_id
     WHERE d.status IN ('pending', 'dead')`);
  const r = rows[0];
  return {
    pending: Number(r?.pending ?? 0),
    oldestPendingMinutes: r?.oldest_minutes === null || r?.oldest_minutes === undefined ? null : Math.max(0, Number(r.oldest_minutes)),
    undelivered: Number(r?.undelivered ?? 0),
    recentUndelivered: Number(r?.recent_undelivered ?? 0),
  };
}

/** One app's outbox, as the stack's Undelivered updates screen and health check use it. */
export interface OutboxAdmin {
  list(limit?: number): Promise<UndeliveredList>;
  retry(eventId: string, subscriber: string): Promise<boolean>;
  retryAll(): Promise<number>;
  health(opts: { recentMs: number }): Promise<OutboxHealth>;
}

export function outboxAdmin(db: Db): OutboxAdmin {
  return {
    list: (limit) => listUndelivered(db, limit),
    retry: (eventId, subscriber) => retryUndelivered(db, eventId, subscriber),
    retryAll: () => retryAllUndelivered(db),
    health: (opts) => outboxHealth(db, opts),
  };
}
