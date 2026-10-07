import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";

/** Keeps a flood day's summary email bounded; the counts stay exact. */
export const SUMMARY_ROW_LIMIT = 500;

/** Distribution's own system priority (priority.ts BASE.system, +2 for internal domains). */
const SYSTEM_PRIORITY_MIN = 100;

export interface SummaryBounceRow {
  address: string;
  status: string | null;
  message: string | null;
  subject: string | null;
  processedAt: string;
}
export interface SummaryList {
  count: number;
  rows: SummaryBounceRow[];
}
export interface BounceSummary {
  processed: number;
  bounces: number;
  ignored: number;
  unrecorded: SummaryList;
  soft: SummaryList;
}

/**
 * NoD's daily bounce summary, for the window (since, until] by processed_at.
 *
 * Soft rows are the calling app's own matched soft bounces. Unrecorded rows are every bounce
 * that matched nothing, plus hard bounces of the calling app's system mail (verification and
 * manage links): those have no delivery row in the app, so the app can never record them, which
 * is exactly what legacy's summary called UNRECORDED.
 *
 * A matched row reports the message's intended recipient, never bounces.recipient, which on a
 * redirecting test site is the redirect mailbox.
 */
export async function bounceSummary(db: Db, w: { since: Date; until: Date; appId: string }): Promise<BounceSummary> {
  const from = sql`
      FROM bounces b
      LEFT JOIN messages m ON m.id = b.message_id
      LEFT JOIN batches bt ON bt.id = m.batch_id
     WHERE b.processed_at > ${w.since} AND b.processed_at <= ${w.until}`;
  const soft = sql`b.kind = 'bounce' AND b.matched AND b.hard = false AND bt.app_id = ${w.appId}`;
  const unrecorded = sql`b.kind = 'bounce' AND (NOT b.matched OR (b.hard AND bt.app_id = ${w.appId} AND m.priority >= ${SYSTEM_PRIORITY_MIN}))`;

  const { rows: countRows } = await db.execute<{ processed: number; bounces: number; ignored: number; soft: number; unrecorded: number }>(sql`
    SELECT count(*)::int AS processed,
           count(*) FILTER (WHERE b.kind = 'bounce')::int AS bounces,
           count(*) FILTER (WHERE b.kind = 'ignored')::int AS ignored,
           count(*) FILTER (WHERE ${soft})::int AS soft,
           count(*) FILTER (WHERE ${unrecorded})::int AS unrecorded
    ${from}`);
  const c = countRows[0]!;

  const rowsWhere = async (filter: SQL): Promise<SummaryBounceRow[]> => {
    const { rows } = await db.execute<{ address: string; status: string | null; message: string | null; subject: string | null; processed_at: string | Date }>(sql`
      SELECT COALESCE(m.email, b.recipient, '') AS address, b.status, b.diagnostic AS message,
             COALESCE(bt.subject, b.original_subject) AS subject, b.processed_at
      ${from} AND ${filter}
      ORDER BY b.processed_at, b.id
      LIMIT ${SUMMARY_ROW_LIMIT}`);
    return rows.map((r) => ({ address: r.address, status: r.status, message: r.message, subject: r.subject, processedAt: new Date(r.processed_at).toISOString() }));
  };

  return {
    processed: c.processed,
    bounces: c.bounces,
    ignored: c.ignored,
    soft: { count: c.soft, rows: await rowsWhere(soft) },
    unrecorded: { count: c.unrecorded, rows: await rowsWhere(unrecorded) },
  };
}
