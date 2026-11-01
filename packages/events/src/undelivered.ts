import { sql, type SQL } from "drizzle-orm";
import { sqlInterval, sqlNow, type Db, type TestClock } from "@gcpe/db-kit";

/**
 * Suite review O1 (owner 2026-10-31): the deliveries the dispatcher gave up on after 24 hours of
 * retries (`status = 'dead'`), for any app's outbox. Generalised from the Calendar's dead-letter
 * page (apps/calendar/src/dead-letters.ts), which now reads through this too. The payload is
 * never returned: only its type, which record it was about and the last error.
 *
 * Fix round 1 (controller rulings 2026-11-01):
 * - I1: an undelivered update is **replaced** when the same outbox holds a newer event for the same
 *   record (aggregate, higher sequence) for the same receiving app, whatever that one's state
 *   (delivered, waiting, undelivered or dismissed). A replaced one is never resent: resending, say,
 *   a "Release published" whose "Release unpublished" is also waiting would email a withdrawn
 *   release. It is refused on its own, skipped by Retry all, and left out of the health count.
 * - M1: an administrator can **dismiss** one (`status = 'dismissed'`): never sent, off the list and
 *   out of the health count. Who and when are recorded by Core (outbox-dismissals.ts).
 * - N1: a retried one is due now(), behind deliveries already due, not at the epoch ahead of them.
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
  /** A newer update for the same record, to the same app, exists: this one is never resent. */
  replaced: boolean;
}

export interface UndeliveredList {
  items: UndeliveredUpdate[];
  /** How many undelivered there are in all; more than `items` holds when the list is cut short. */
  total: number;
  /** How many of `total` are replaced (never resent). */
  replaced: number;
  truncated: boolean;
}

/** How many undelivered updates a list returns, newest first. */
export const UNDELIVERED_LIMIT = 200;

/** `d` (outbox_deliveries) / `e` (outbox_events) has a newer event for its record to its subscriber. */
const REPLACED = sql`EXISTS (
  SELECT 1 FROM outbox_deliveries d2 JOIN outbox_events e2 ON e2.id = d2.event_id
   WHERE d2.subscriber = d.subscriber AND e2.aggregate_id = e.aggregate_id AND e2.sequence > e.sequence)`;

/** Only the few fields "about" needs are read out of the envelope, never the whole of it. */
const FIELDS = sql`d.event_id, d.subscriber, d.attempts, d.last_error, e.type, e.aggregate_id, e.created_at,
  e.envelope -> 'data' ->> 'key' AS key,
  e.envelope -> 'data' -> 'documents' -> 0 ->> 'headline' AS headline,
  e.envelope -> 'data' ->> 'displayName' AS display_name,
  e.envelope -> 'data' ->> 'id' AS activity_id,
  ${REPLACED} AS replaced`;

type Row = {
  event_id: string;
  subscriber: string;
  attempts: number;
  last_error: string | null;
  type: string;
  aggregate_id: string;
  created_at: string | Date;
  key: string | null;
  headline: string | null;
  display_name: string | null;
  activity_id: string | null;
  replaced: boolean;
};

function aboutOf(r: Row): string | null {
  if (r.type.startsWith("release.")) return r.headline || r.key;
  if (r.type.startsWith("activity.")) return r.activity_id ? `Activity ${r.activity_id}` : null;
  if (r.type === "user.upserted") return r.display_name;
  return r.key;
}

function toUpdate(r: Row): UndeliveredUpdate {
  return {
    eventId: r.event_id,
    subscriber: r.subscriber,
    type: r.type,
    aggregateId: r.aggregate_id,
    about: aboutOf(r),
    attempts: Number(r.attempts),
    lastError: r.last_error,
    // A raw execute returns timestamptz as Postgres's text.
    createdAt: new Date(r.created_at).toISOString(),
    replaced: r.replaced === true,
  };
}

async function listByStatus(db: Db, status: "dead" | "dismissed", limit: number): Promise<UndeliveredList> {
  const { rows } = await db.execute<Row>(sql`
    SELECT ${FIELDS} FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
     WHERE d.status = ${status}
     ORDER BY e.created_at DESC, d.event_id, d.subscriber
     LIMIT ${limit + 1}`);
  const { rows: counts } = await db.execute<{ total: number; replaced: number }>(sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE ${REPLACED})::int AS replaced
      FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
     WHERE d.status = ${status}`);
  return {
    items: rows.slice(0, limit).map(toUpdate),
    total: Number(counts[0]?.total ?? 0),
    replaced: Number(counts[0]?.replaced ?? 0),
    truncated: rows.length > limit,
  };
}

export const listUndelivered = (db: Db, limit = UNDELIVERED_LIMIT): Promise<UndeliveredList> => listByStatus(db, "dead", limit);

/** The updates an administrator dismissed, newest queued first. */
export const listDismissed = (db: Db, limit = UNDELIVERED_LIMIT): Promise<UndeliveredList> => listByStatus(db, "dismissed", limit);

const requeue = sql`status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL`;

export type RetryOutcome = "queued" | "replaced" | "not-found";

/**
 * Puts one undelivered update back in the queue: the next dispatch tries it once more. The event
 * is already past the dispatcher's 24 hours, so a failure makes it undelivered again straight away.
 * "replaced" (left as it is) when a newer update for the same record to the same app exists;
 * "not-found" when there is no such undelivered update (already retried, delivered or dismissed).
 */
export async function retryUndelivered(db: Db, eventId: string, subscriber: string): Promise<RetryOutcome> {
  const one = sql`d.event_id = ${eventId} AND d.subscriber = ${subscriber} AND d.status = 'dead'`;
  const r = await db.execute(sql`UPDATE outbox_deliveries d SET ${requeue} FROM outbox_events e WHERE e.id = d.event_id AND ${one} AND NOT ${REPLACED}`);
  if ((r.rowCount ?? 0) > 0) return "queued";
  const { rows } = await db.execute(sql`SELECT 1 FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE ${one}`);
  return rows.length > 0 ? "replaced" : "not-found";
}

/**
 * Puts every undelivered update in this outbox that nothing replaced back in the queue, all due at
 * the same instant, so the dispatcher sends them oldest first (its claim orders by queue time and
 * sequence). Replaced ones are left undelivered and counted.
 */
export async function retryAllUndelivered(db: Db): Promise<{ retried: number; replaced: number }> {
  const r = await db.execute(sql`UPDATE outbox_deliveries d SET ${requeue} FROM outbox_events e WHERE e.id = d.event_id AND d.status = 'dead' AND NOT ${REPLACED}`);
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_deliveries WHERE status = 'dead'`);
  return { retried: r.rowCount ?? 0, replaced: Number(rows[0]?.n ?? 0) };
}

async function dismissWhere(db: Db, where: SQL): Promise<UndeliveredUpdate[]> {
  // Read before the write so the result says what each one was (about, replaced) as it stood.
  const { rows } = await db.execute<Row>(sql`
    WITH chosen AS (
      SELECT ${FIELDS} FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id
       WHERE d.status = 'dead' AND ${where} FOR UPDATE OF d),
    done AS (
      UPDATE outbox_deliveries d SET status = 'dismissed', locked_until = NULL
        FROM chosen c WHERE d.event_id = c.event_id AND d.subscriber = c.subscriber AND d.status = 'dead'
      RETURNING d.event_id, d.subscriber)
    SELECT c.* FROM chosen c JOIN done USING (event_id, subscriber)
     ORDER BY c.created_at, c.event_id, c.subscriber`);
  return rows.map(toUpdate);
}

/** Marks one undelivered update as handled without sending it; null when there is no such undelivered update. */
export async function dismissUndelivered(db: Db, eventId: string, subscriber: string): Promise<UndeliveredUpdate | null> {
  return (await dismissWhere(db, sql`d.event_id = ${eventId} AND d.subscriber = ${subscriber}`))[0] ?? null;
}

/** Marks every undelivered update in this outbox, replaced ones included, as handled; the ones it marked. */
export const dismissAllUndelivered = (db: Db): Promise<UndeliveredUpdate[]> => dismissWhere(db, sql`true`);

export interface OutboxHealth {
  /** Deliveries still waiting to go (including ones being retried). */
  pending: number;
  /** How long the oldest waiting delivery's event has waited, in whole minutes; null when none waits. */
  oldestPendingMinutes: number | null;
  /** Undelivered updates nothing replaced (dismissed ones are never counted). */
  undelivered: number;
  /** Undelivered updates a newer one replaced: never resent, never alerting. */
  replaced: number;
  /** Undelivered updates nothing replaced whose event was queued within `recentMs`. */
  recentUndelivered: number;
}

/** The outbox's backlog for `/stack/health` (suite review O2.1), by the database's clock. */
export async function outboxHealth(db: Db, opts: { recentMs: number; now?: TestClock }): Promise<OutboxHealth> {
  const now = sqlNow(opts.now);
  const { rows } = await db.execute<{ pending: number; oldest_minutes: number | null; undelivered: number; replaced: number; recent_undelivered: number }>(sql`
    SELECT count(*) FILTER (WHERE d.status = 'pending')::int AS pending,
           floor(extract(epoch from (${now} - min(e.created_at) FILTER (WHERE d.status = 'pending'))) / 60)::int AS oldest_minutes,
           count(*) FILTER (WHERE d.status = 'dead' AND NOT ${REPLACED})::int AS undelivered,
           count(*) FILTER (WHERE d.status = 'dead' AND ${REPLACED})::int AS replaced,
           count(*) FILTER (WHERE d.status = 'dead' AND NOT ${REPLACED} AND e.created_at > ${now} - ${sqlInterval(opts.recentMs)})::int AS recent_undelivered
      FROM outbox_deliveries d
      JOIN outbox_events e ON e.id = d.event_id
     WHERE d.status IN ('pending', 'dead')`);
  const r = rows[0];
  return {
    pending: Number(r?.pending ?? 0),
    oldestPendingMinutes: r?.oldest_minutes === null || r?.oldest_minutes === undefined ? null : Math.max(0, Number(r.oldest_minutes)),
    undelivered: Number(r?.undelivered ?? 0),
    replaced: Number(r?.replaced ?? 0),
    recentUndelivered: Number(r?.recent_undelivered ?? 0),
  };
}

/** One app's outbox, as the stack's Undelivered updates screen and health check use it. */
export interface OutboxAdmin {
  list(limit?: number): Promise<UndeliveredList>;
  listDismissed(limit?: number): Promise<UndeliveredList>;
  retry(eventId: string, subscriber: string): Promise<RetryOutcome>;
  retryAll(): Promise<{ retried: number; replaced: number }>;
  dismiss(eventId: string, subscriber: string): Promise<UndeliveredUpdate | null>;
  dismissAll(): Promise<UndeliveredUpdate[]>;
  health(opts: { recentMs: number }): Promise<OutboxHealth>;
}

export function outboxAdmin(db: Db): OutboxAdmin {
  return {
    list: (limit) => listUndelivered(db, limit),
    listDismissed: (limit) => listDismissed(db, limit),
    retry: (eventId, subscriber) => retryUndelivered(db, eventId, subscriber),
    retryAll: () => retryAllUndelivered(db),
    dismiss: (eventId, subscriber) => dismissUndelivered(db, eventId, subscriber),
    dismissAll: () => dismissAllUndelivered(db),
    health: (opts) => outboxHealth(db, opts),
  };
}
