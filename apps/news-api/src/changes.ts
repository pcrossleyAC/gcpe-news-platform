import { asc, gt, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import { changeFeedState, changes, type ChangeKind } from "./db/schema";

/** Two-int advisory key (the "gcpe" space db-kit's migration lock uses); 4 is this feed's. */
export const CHANGES_LOCK = [0x67637065, 4] as const;
export const CHANGES_RETENTION_DAYS = 90;
export const CHANGES_MAX_LIMIT = 500;
export const CHANGES_DEFAULT_LIMIT = 100;

export const CATEGORY_CHANGE_KIND: Record<CategoryKind, ChangeKind> = { ministries: "ministry", sectors: "sector", themes: "theme", tags: "tag" };

export interface Change {
  kind: ChangeKind;
  key: string | null;
}

/**
 * Writes `rows` to the change feed in the caller's transaction (spec §5.4). The advisory lock,
 * held until commit, serialises every writer from this point on, so ids become visible in id
 * order: a reader whose cursor has passed id N can never later find an id below N commit. It is
 * always the last lock a projection transaction takes. One JSON parameter, whatever the count.
 */
export async function recordChanges(tx: Tx, rows: Change[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHANGES_LOCK[0]}, ${CHANGES_LOCK[1]})`);
  await tx.execute(sql`
    INSERT INTO changes (kind, key)
    SELECT c.kind, c.key FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS c(kind text, key text)`);
}

export type ChangesRead =
  | { resync: false; changes: { id: number; kind: ChangeKind; key: string | null; at: Date }[]; next: number }
  | { resync: true; next: number };

/**
 * Changes with id > `after`, oldest first, at most `limit`. A cursor below the highest pruned id
 * has missed changes: resync, with the current head as the place to resume after a full rebuild.
 */
export async function readChanges(db: Db, after: number, limit: number): Promise<ChangesRead> {
  return db.transaction(
    async (tx) => {
      const [state] = await tx.select({ prunedThrough: changeFeedState.prunedThrough }).from(changeFeedState);
      const prunedThrough = state?.prunedThrough ?? 0;
      if (after < prunedThrough) {
        const [{ head } = { head: null }] = await tx.select({ head: sql<string | null>`max(${changes.id})` }).from(changes);
        return { resync: true as const, next: head === null ? prunedThrough : Number(head) };
      }
      const rows = await tx.select().from(changes).where(gt(changes.id, after)).orderBy(asc(changes.id)).limit(limit);
      return { resync: false as const, changes: rows, next: rows.length > 0 ? rows[rows.length - 1]!.id : after };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Deletes changes older than `retentionDays` and raises the pruned-through watermark. */
export async function pruneChanges(db: Db, retentionDays = CHANGES_RETENTION_DAYS): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    WITH deleted AS (
      DELETE FROM changes WHERE at < now() - make_interval(days => ${retentionDays}) RETURNING id
    ), watermark AS (
      INSERT INTO change_feed_state (id, pruned_through)
      SELECT 1, max(id) FROM deleted HAVING max(id) IS NOT NULL
      ON CONFLICT (id) DO UPDATE SET pruned_through = greatest(change_feed_state.pruned_through, excluded.pruned_through)
    )
    SELECT count(*)::int AS n FROM deleted`);
  return rows[0]?.n ?? 0;
}
