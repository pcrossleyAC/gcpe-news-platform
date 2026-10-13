import { asc, gt, inArray } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { ObjectStore } from "@gcpe/storage";
import { activities, activityFiles } from "../db/schema";

/** Activities whose folders one call lists. */
export const ORPHAN_SWEEP_ACTIVITIES = 200;
/** Objects one call deletes at most. */
export const ORPHAN_SWEEP_MAX_DELETES = 50;
/**
 * Bytes younger than this are never swept. An upload stores its bytes before its row commits,
 * always under a new random key, so a fresh object with no row may be an upload still in flight.
 */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const KEY_CHECK_CHUNK = 500;

export interface OrphanSweepResult {
  scanned: number;
  deleted: number;
  failed: number;
}

export interface OrphanSweepOptions {
  activities?: number;
  maxDeletes?: number;
  minAgeMs?: number;
  now?: () => Date;
}

/**
 * Finds and deletes attachment bytes no `activity_files` row references: the bytes left behind
 * when a replace or remove committed but the store delete after it failed. Each call walks the
 * next batch of activities by id, from a cursor kept in memory, and wraps to the start after
 * the last one.
 */
export function createOrphanSweeper(db: Db, store: ObjectStore, opts: OrphanSweepOptions = {}): () => Promise<OrphanSweepResult> {
  const size = opts.activities ?? ORPHAN_SWEEP_ACTIVITIES;
  const maxDeletes = opts.maxDeletes ?? ORPHAN_SWEEP_MAX_DELETES;
  const minAgeMs = opts.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const now = opts.now ?? (() => new Date());
  let after = 0;

  return async () => {
    const ids = (await db.select({ id: activities.id }).from(activities).where(gt(activities.id, after)).orderBy(asc(activities.id)).limit(size)).map((r) => r.id);
    const cutoff = now().getTime() - minAgeMs;

    // List the bytes before reading any row, so a row that committed before the reads below is seen.
    const aged: { activityId: number; key: string }[] = [];
    for (const id of ids) {
      for (const o of await store.list(`activities/${id}`)) if (o.updatedAt.getTime() <= cutoff) aged.push({ activityId: id, key: o.key });
    }

    const referenced = new Set<string>();
    if (ids.length > 0) {
      for (const r of await db.select({ key: activityFiles.storageKey }).from(activityFiles).where(inArray(activityFiles.activityId, ids))) referenced.add(r.key);
    }
    // Any row anywhere keeps its bytes, not only a row on the activity whose folder holds them.
    const unreferenced = aged.filter((o) => !referenced.has(o.key));
    for (let i = 0; i < unreferenced.length; i += KEY_CHECK_CHUNK) {
      const chunk = unreferenced.slice(i, i + KEY_CHECK_CHUNK).map((o) => o.key);
      for (const r of await db.select({ key: activityFiles.storageKey }).from(activityFiles).where(inArray(activityFiles.storageKey, chunk))) referenced.add(r.key);
    }
    const orphans = unreferenced.filter((o) => !referenced.has(o.key));

    let deleted = 0;
    let failed = 0;
    for (const o of orphans.slice(0, maxDeletes)) {
      try {
        if (await store.delete(o.key)) deleted++;
      } catch (e) {
        failed++;
        console.error("[calendar] orphan sweep could not delete a stored file", safeErrorLabel(e));
      }
    }

    if (orphans.length > maxDeletes && deleted > 0) {
      // More orphans than one call may delete: come back to the first activity not finished.
      const i = ids.indexOf(orphans[maxDeletes]!.activityId);
      if (i > 0) after = ids[i - 1]!;
    } else {
      after = ids.length < size ? 0 : ids[ids.length - 1]!;
    }
    return { scanned: ids.length, deleted, failed };
  };
}
