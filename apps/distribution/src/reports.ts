/**
 * Sent vs bounced per day and sending app, for NoD's staff report (spec §8). The caller supplies
 * the day boundaries (NoD computes BC midnights from its tenant zone), so this service stays
 * zone-free and Postgres's own tzdata is never consulted. Day i is [bounds[i], bounds[i + 1]).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@gcpe/db-kit";

/** NoD caps a report at 92 days; one more boundary closes the last day. */
export const MAX_REPORT_DAYS = 92;
/** The longest first-to-last span accepted: 92 local days can run an hour over 92 x 24 h when
 * they cross a fall-back, so a day of slack; the boundary count alone doesn't bound it, since
 * two boundaries can be any distance apart. */
const MAX_SPAN_MS = (MAX_REPORT_DAYS + 1) * 86_400_000;
const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be a valid date" });
export const dailyReportSchema = z
  .object({ bounds: z.array(isoInstant).min(2).max(MAX_REPORT_DAYS + 1) })
  .refine((b) => b.bounds.every((v, i) => i === 0 || Date.parse(v) > Date.parse(b.bounds[i - 1]!)), { message: "bounds must increase", path: ["bounds"] })
  .refine((b) => Date.parse(b.bounds[b.bounds.length - 1]!) - Date.parse(b.bounds[0]!) <= MAX_SPAN_MS, {
    message: `bounds must span at most ${MAX_REPORT_DAYS + 1} days`,
    path: ["bounds"],
  });

export interface DailyReportRow {
  day: number;
  appId: string;
  sent: number;
  hardBounced: number;
  softBounced: number;
  failed: number;
}

/** Sent and bounced count by send time; failed by when the batch was queued (no send time). */
export function dailyReportSql(bounds: Date[]): SQL {
  const first = bounds[0]!;
  const last = bounds[bounds.length - 1]!;
  const edges = sql`${sql.param(bounds.map((b) => b.toISOString()))}::timestamptz[]`;
  return sql`
    WITH sent AS (
      SELECT width_bucket(m.sent_at, ${edges}) - 1 AS day, b.app_id,
             count(*)::int AS sent,
             count(*) FILTER (WHERE m.bounce_hard)::int AS hard,
             count(*) FILTER (WHERE m.bounce_hard = false)::int AS soft
        FROM messages m JOIN batches b ON b.id = m.batch_id
       WHERE m.status = 'sent' AND m.sent_at >= ${first} AND m.sent_at < ${last}
       GROUP BY 1, 2),
    failed AS (
      SELECT width_bucket(b.created_at, ${edges}) - 1 AS day, b.app_id, count(*)::int AS failed
        FROM messages m JOIN batches b ON b.id = m.batch_id
       WHERE m.status = 'failed' AND b.created_at >= ${first} AND b.created_at < ${last}
       GROUP BY 1, 2)
    SELECT COALESCE(s.day, f.day) AS day, COALESCE(s.app_id, f.app_id) AS app_id,
           COALESCE(s.sent, 0) AS sent, COALESCE(s.hard, 0) AS hard_bounced,
           COALESCE(s.soft, 0) AS soft_bounced, COALESCE(f.failed, 0) AS failed
      FROM sent s FULL JOIN failed f ON f.day = s.day AND f.app_id = s.app_id
     ORDER BY 1, 2`;
}

export async function dailyReport(db: DbOrTx, bounds: Date[]): Promise<DailyReportRow[]> {
  const { rows } = await db.execute<{ day: number; app_id: string; sent: number; hard_bounced: number; soft_bounced: number; failed: number }>(dailyReportSql(bounds));
  return rows.map((r) => ({ day: r.day, appId: r.app_id, sent: r.sent, hardBounced: r.hard_bounced, softBounced: r.soft_bounced, failed: r.failed }));
}
