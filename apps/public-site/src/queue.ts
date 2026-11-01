import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { CATEGORY_INDEX_IDS } from "./site-paths";

/** Lower drains first. A post's dependents go one step later (dependentPriority). */
export const PRIORITY = { livePost: 0, liveAggregate: 1, bulkPost: 2, bulkAggregate: 3 } as const;

export const dependentPriority = (p: number, pageId?: string): number =>
  // A category index fetches the latest posts of every category of its kind, so a post change (even
  // a live one) queues it behind everything else; the queue's one row per page folds a batch of
  // posts into one render.
  pageId !== undefined && (CATEGORY_INDEX_IDS as readonly string[]).includes(pageId) ? PRIORITY.bulkAggregate : p === PRIORITY.livePost ? PRIORITY.liveAggregate : p === PRIORITY.bulkPost ? PRIORITY.bulkAggregate : p;

export interface QueueItem {
  pageId: string;
  priority: number;
  seq: number;
  attempts: number;
}

/** Rows per statement: one JSON parameter each (Global Constraints). */
const CHUNK = 20_000;

/**
 * Queues pages. A repeated id (in the input or already queued) keeps the lowest priority and
 * takes a fresh seq; input order decides seq order (WITH ORDINALITY), so a caller can queue
 * newest first.
 */
export async function enqueuePages(db: DbOrTx, items: { pageId: string; priority: number }[]): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map((x) => ({ page_id: x.pageId, priority: x.priority }));
    await db.execute(sql`
      INSERT INTO rebuild_queue (page_id, priority)
      SELECT d.page_id, d.priority FROM (
        SELECT DISTINCT ON (x.page_id) x.page_id, x.priority, x.ord
        FROM ROWS FROM (jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS (page_id text, priority smallint)) WITH ORDINALITY AS x(page_id, priority, ord)
        ORDER BY x.page_id, x.priority, x.ord
      ) d
      ORDER BY d.ord
      ON CONFLICT (page_id) DO UPDATE SET
        priority = least(rebuild_queue.priority, excluded.priority),
        seq = nextval(pg_get_serial_sequence('rebuild_queue', 'seq')),
        queued_at = now()`);
  }
}

export async function nextBatch(db: DbOrTx, limit: number, skip: string[]): Promise<QueueItem[]> {
  const { rows } = await db.execute<{ page_id: string; priority: number; seq: string; attempts: number }>(sql`
    SELECT page_id, priority, seq, attempts FROM rebuild_queue
    WHERE NOT (page_id = ANY (SELECT jsonb_array_elements_text(${JSON.stringify(skip)}::jsonb)))
    ORDER BY priority, seq
    LIMIT ${limit}`);
  return rows.map((r) => ({ pageId: r.page_id, priority: Number(r.priority), seq: Number(r.seq), attempts: Number(r.attempts) }));
}

/** Deletes the row only if nobody re-queued it since it was read. */
export async function completePage(db: DbOrTx, item: QueueItem): Promise<boolean> {
  const { rows } = await db.execute(sql`DELETE FROM rebuild_queue WHERE page_id = ${item.pageId} AND seq = ${item.seq} RETURNING page_id`);
  return rows.length > 0;
}

export async function deferPage(db: DbOrTx, item: QueueItem): Promise<void> {
  await db.execute(sql`
    UPDATE rebuild_queue SET attempts = attempts + 1, seq = nextval(pg_get_serial_sequence('rebuild_queue', 'seq'))
    WHERE page_id = ${item.pageId} AND seq = ${item.seq}`);
}

export async function queueDepth(db: DbOrTx): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rebuild_queue`);
  return rows[0]?.n ?? 0;
}

/** Suite review O2.1: the queue's length and its oldest page's wait in whole minutes, for `/stack/health`. */
export async function queueHealth(db: DbOrTx): Promise<{ pages: number; oldestMinutes: number | null }> {
  const { rows } = await db.execute<{ n: number; oldest: number | null }>(
    sql`SELECT count(*)::int AS n, floor(extract(epoch from (now() - min(queued_at))) / 60)::int AS oldest FROM rebuild_queue`,
  );
  const n = Number(rows[0]?.n ?? 0);
  return { pages: n, oldestMinutes: n === 0 || rows[0]?.oldest == null ? null : Math.max(0, Number(rows[0].oldest)) };
}
