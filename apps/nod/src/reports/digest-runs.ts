/**
 * Daily digest runs (spec §8): one row per run (its 17:00 cutoff) in the range. Units are emails,
 * one per subscriber per run, not delivery rows (a digest leaves one row per item). A run's jobs
 * are found by their key prefix; cancelled jobs (every item withdrawn) sent nothing and are left
 * out. "Items" counts what the run's window offers now: the digest's own filter, before matching,
 * computed live, so an item withdrawn since the run drops out (nothing records the run's own
 * count). "Handed off, not bounced" is given to Distribution less bounces, not delivery.
 */
import { and, desc, gte, lt, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { digestRuns, items } from "../db/schema";
import { DIGEST_JOB_PREFIX_LENGTH, digestJobKeyPrefix } from "../digest";
import type { CsvCell } from "./csv";
import { localDateTime, type ReportRange } from "./range";
import type { RangedPage } from "./release-sends";

export const DIGEST_RUNS_PAGE_SIZE = 31;

export interface DigestRunRow {
  cutoff: string;
  ranAt: string;
  items: number;
  subscribers: number;
  handedOffNotBounced: number;
  bounced: number;
  notSent: number;
}

const inRange = (range: ReportRange) => and(gte(digestRuns.cutoff, range.start), lt(digestRuns.cutoff, range.end));

function runs(db: DbOrTx, range: ReportRange, limit: number, offset: number) {
  return db
    .select({
      cutoff: digestRuns.cutoff,
      ranAt: digestRuns.ranAt,
      items: sql<number>`(SELECT count(*)::int FROM ${items} i
         WHERE i.kind = 'release' AND i.to_subscribers AND i.withdrawn_at IS NULL
           AND COALESCE(i.post_kind, '') <> 'advisories'
           AND i.published_at > ${digestRuns.windowStart} AND i.published_at <= ${digestRuns.cutoff})`,
    })
    .from(digestRuns)
    .where(inRange(range))
    .orderBy(desc(digestRuns.cutoff))
    .limit(limit)
    .offset(offset);
}

/** The prefix expression exactly as send_jobs_digest_run_idx is built: a literal length, not a
 * bound parameter, or Postgres can't match the query to the index. */
const jobPrefix = sql.raw(`left(j.job_key, ${DIGEST_JOB_PREFIX_LENGTH})`);

/** Emails per run prefix: all, not yet handed to Distribution, and bounced. */
export function digestRunCountsSql(prefixes: string[]): SQL {
  return sql`
    WITH jobs AS (
      SELECT ${jobPrefix} AS prefix, j.id
        FROM send_jobs j
       WHERE j.kind = 'digest' AND j.status <> 'cancelled'
         AND ${jobPrefix} = ANY(${sql.param(prefixes)}::text[])),
    per AS (SELECT prefix, array_agg(id) AS ids FROM jobs GROUP BY prefix)
    SELECT per.prefix,
           (SELECT count(*) FROM job_recipients jr WHERE jr.job_id = ANY(per.ids))::int AS emails,
           (SELECT count(DISTINCT d.subscriber_id) FROM deliveries d
             WHERE d.job_id = ANY(per.ids) AND d.distribution_batch_id IS NULL)::int AS not_sent,
           (SELECT count(DISTINCT d.subscriber_id) FROM deliveries d
             WHERE d.job_id = ANY(per.ids) AND d.bounce_status IS NOT NULL)::int AS bounced
      FROM per`;
}

async function withCounts(db: DbOrTx, rows: { cutoff: Date; ranAt: Date; items: number }[]): Promise<DigestRunRow[]> {
  if (rows.length === 0) return [];
  const { rows: counts } = await db.execute<{ prefix: string; emails: number; not_sent: number; bounced: number }>(
    digestRunCountsSql(rows.map((r) => digestJobKeyPrefix(r.cutoff))),
  );
  const by = new Map(counts.map((c) => [c.prefix, c]));
  return rows.map((r) => {
    const c = by.get(digestJobKeyPrefix(r.cutoff));
    const emails = c?.emails ?? 0;
    const notSent = c?.not_sent ?? 0;
    const bounced = c?.bounced ?? 0;
    return {
      cutoff: r.cutoff.toISOString(),
      ranAt: r.ranAt.toISOString(),
      items: r.items,
      subscribers: emails,
      handedOffNotBounced: Math.max(0, emails - notSent - bounced),
      bounced,
      notSent,
    };
  });
}

export async function digestRunsPage(db: DbOrTx, range: ReportRange, page: number): Promise<RangedPage<DigestRunRow>> {
  const rows = await runs(db, range, DIGEST_RUNS_PAGE_SIZE, (page - 1) * DIGEST_RUNS_PAGE_SIZE);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(digestRuns).where(inRange(range))) as [{ n: number }];
  return { from: range.from, to: range.to, total: n, page, pageSize: DIGEST_RUNS_PAGE_SIZE, items: await withCounts(db, rows) };
}

/** A range holds at most 92 runs (one cutoff a day, catch-ups included), so one batch. */
export async function* digestRunBatches(db: DbOrTx, range: ReportRange): AsyncGenerator<DigestRunRow[]> {
  yield await withCounts(db, await runs(db, range, 1000, 0));
}

export const DIGEST_RUNS_CSV_HEADER = ["Run (BC time)", "Ran at (BC time)", "Items in window", "Subscribers", "Handed off, not bounced", "Bounced", "Not sent"];
export function digestRunCsvRow(r: DigestRunRow, timeZone: string): CsvCell[] {
  return [localDateTime(new Date(r.cutoff), timeZone), localDateTime(new Date(r.ranAt), timeZone), r.items, r.subscribers, r.handedOffNotBounced, r.bounced, r.notSent];
}
