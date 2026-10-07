/**
 * Recent unsubscribes (spec §8; legacy RecentUnsubscribersReport): everyone whose latest
 * unsubscribe falls between BC midnight 90 days ago and now, one row each. An unsubscribe is the
 * subscriber's own `unsubscribed` or staff's `staff-deleted`. A bounce-disabled subscriber
 * hasn't unsubscribed and isn't listed (Q40).
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { SubscriberStatus } from "../db/schema";
import type { CsvCell } from "./csv";
import { addDays, bcToday, dayBounds, localDateTime } from "./range";

export const UNSUBSCRIBE_WINDOW_DAYS = 90;
export const UNSUBSCRIBES_PAGE_SIZE = 50;
export const UNSUBSCRIBE_ACTIONS = ["unsubscribed", "staff-deleted"] as const;
/** `confirmed` predates the subscribed/resubscribed split and counts as new. */
const SUMMARY_ACTIONS = ["subscribed", "confirmed", "resubscribed", ...UNSUBSCRIBE_ACTIONS] as const;

export type UnsubscribeHow = "subscriber" | "staff";
export interface UnsubscribeRow {
  subscriberId: string;
  email: string;
  how: UnsubscribeHow;
  at: string;
  status: SubscriberStatus;
  registeredAt: string;
}
export interface UnsubscribeSummary {
  subscribed: number;
  resubscribed: number;
  unsubscribed: number;
  staffDeleted: number;
}
export interface UnsubscribesPage {
  since: string;
  summary: UnsubscribeSummary;
  total: number;
  page: number;
  pageSize: number;
  items: UnsubscribeRow[];
}
export interface UnsubscribeWindow {
  since: string;
  today: string;
  start: Date;
  days: number;
  bounds: Date[];
}

export async function unsubscribeWindow(db: DbOrTx, timeZone: string): Promise<UnsubscribeWindow> {
  const today = await bcToday(db, timeZone);
  const since = addDays(today, -UNSUBSCRIBE_WINDOW_DAYS);
  const days = UNSUBSCRIBE_WINDOW_DAYS + 1;
  const bounds = dayBounds(since, days, timeZone);
  return { since, today, start: bounds[0]!, days, bounds };
}

const actionList = (actions: readonly string[]): SQL => sql.join(actions.map((a) => sql`${a}`), sql`, `);

/** Where a CSV export stands: history is read as of `asOf` (the database clock when it began), and
 * each batch starts strictly after the previous one's last row. Times are kept exactly as Postgres
 * returned them, to the microsecond. */
type Resume = { asOf: string; after: { at: string; subscriberId: string } | null };

/** One row per person, their latest unsubscribe at or after `start`, newest first. A page uses
 * LIMIT/OFFSET; a CSV batch passes `resume`, so an unsubscribe landing mid-export can neither
 * shift a row into two batches nor move someone not yet written past the point already reached. */
export function unsubscribesSql(start: Date, limit: number, offset: number, resume: Resume | null = null): SQL {
  const asOf = resume ? sql`AND h.at <= ${resume.asOf}::timestamptz` : sql``;
  const after = resume?.after ? sql`WHERE (l.at, l.subscriber_id) < (${resume.after.at}::timestamptz, ${resume.after.subscriberId}::uuid)` : sql``;
  return sql`
    WITH latest AS (
      SELECT DISTINCT ON (h.subscriber_id) h.subscriber_id, h.action, h.at
        FROM subscriber_history h
       WHERE h.action IN (${actionList(UNSUBSCRIBE_ACTIONS)}) AND h.at >= ${start} ${asOf}
       ORDER BY h.subscriber_id, h.at DESC, h.id DESC)
    SELECT l.subscriber_id, l.action, l.at, s.email, s.status, s.created_at
      FROM latest l
      JOIN subscribers s ON s.id = l.subscriber_id
     ${after}
     ORDER BY l.at DESC, l.subscriber_id DESC
     LIMIT ${limit} OFFSET ${offset}`;
}

type RawRow = {
  subscriber_id: string;
  action: string;
  at: string;
  email: string;
  status: SubscriberStatus;
  created_at: string;
};
const toRow = (r: RawRow): UnsubscribeRow => ({
  subscriberId: r.subscriber_id,
  email: r.email,
  how: r.action === "staff-deleted" ? "staff" : "subscriber",
  at: new Date(r.at).toISOString(),
  status: r.status,
  registeredAt: new Date(r.created_at).toISOString(),
});

async function summary(db: DbOrTx, start: Date): Promise<UnsubscribeSummary> {
  const { rows } = await db.execute<{ subscribed: number; resubscribed: number; unsubscribed: number; staff_deleted: number }>(sql`
    SELECT count(*) FILTER (WHERE action IN ('subscribed', 'confirmed'))::int AS subscribed,
           count(*) FILTER (WHERE action = 'resubscribed')::int AS resubscribed,
           count(*) FILTER (WHERE action = 'unsubscribed')::int AS unsubscribed,
           count(*) FILTER (WHERE action = 'staff-deleted')::int AS staff_deleted
      FROM subscriber_history
     WHERE action IN (${actionList(SUMMARY_ACTIONS)}) AND at >= ${start}`);
  const r = rows[0]!;
  return { subscribed: r.subscribed, resubscribed: r.resubscribed, unsubscribed: r.unsubscribed, staffDeleted: r.staff_deleted };
}

export async function unsubscribesPage(db: DbOrTx, window: UnsubscribeWindow, page: number): Promise<UnsubscribesPage> {
  const { rows } = await db.execute<RawRow>(unsubscribesSql(window.start, UNSUBSCRIBES_PAGE_SIZE, (page - 1) * UNSUBSCRIBES_PAGE_SIZE));
  const { rows: total } = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT subscriber_id)::int AS n FROM subscriber_history
     WHERE action IN (${actionList(UNSUBSCRIBE_ACTIONS)}) AND at >= ${window.start}`);
  return {
    since: window.since,
    summary: await summary(db, window.start),
    total: total[0]!.n,
    page,
    pageSize: UNSUBSCRIBES_PAGE_SIZE,
    items: rows.map(toRow),
  };
}

export async function* unsubscribeBatches(db: DbOrTx, window: UnsubscribeWindow, batchSize = 1000): AsyncGenerator<UnsubscribeRow[]> {
  const { rows: clock } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  const resume: Resume = { asOf: clock[0]!.now, after: null };
  for (;;) {
    const { rows } = await db.execute<RawRow>(unsubscribesSql(window.start, batchSize, 0, resume));
    if (rows.length > 0) yield rows.map(toRow);
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1]!;
    resume.after = { at: last.at, subscriberId: last.subscriber_id };
  }
}

export const UNSUBSCRIBE_COUNTS_HEADER = ["Date", "New subscriptions", "Returning", "Unsubscribed", "Deleted by staff"];

/** One row per BC day of the window, oldest first, zeros included. Counts events, not people. */
export async function unsubscribeDailyCounts(db: DbOrTx, window: UnsubscribeWindow): Promise<CsvCell[][]> {
  const bounds = sql`${sql.param(window.bounds.map((b) => b.toISOString()))}::timestamptz[]`;
  const { rows } = await db.execute<{ day: number; subscribed: number; resubscribed: number; unsubscribed: number; staff_deleted: number }>(sql`
    SELECT width_bucket(at, ${bounds}) - 1 AS day,
           count(*) FILTER (WHERE action IN ('subscribed', 'confirmed'))::int AS subscribed,
           count(*) FILTER (WHERE action = 'resubscribed')::int AS resubscribed,
           count(*) FILTER (WHERE action = 'unsubscribed')::int AS unsubscribed,
           count(*) FILTER (WHERE action = 'staff-deleted')::int AS staff_deleted
      FROM subscriber_history
     WHERE action IN (${actionList(SUMMARY_ACTIONS)}) AND at >= ${window.start} AND at < ${window.bounds[window.days]!}
     GROUP BY 1`);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: window.days }, (_, i): CsvCell[] => {
    const r = byDay.get(i);
    return [addDays(window.since, i), r?.subscribed ?? 0, r?.resubscribed ?? 0, r?.unsubscribed ?? 0, r?.staff_deleted ?? 0];
  });
}

const STATUS_TEXT: Record<SubscriberStatus, string> = { pending: "Pending", active: "Active", disabled: "Disabled", deleted: "Deleted" };
export const UNSUBSCRIBE_CSV_HEADER = ["Email", "How", "When (BC time)", "Status now", "Registered (BC time)"];
export function unsubscribeCsvRow(r: UnsubscribeRow, timeZone: string): CsvCell[] {
  return [
    r.email,
    r.how === "staff" ? "Deleted by staff" : "Unsubscribed",
    localDateTime(new Date(r.at), timeZone),
    STATUS_TEXT[r.status],
    localDateTime(new Date(r.registeredAt), timeZone),
  ];
}
