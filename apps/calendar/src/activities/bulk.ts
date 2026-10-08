import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { addDays, bcMidnight, dbNow, wallClock } from "../time";
import { visible, visibleSql } from "../visibility";
import { ActivityForbiddenError } from "./errors";
import { emitActivity } from "./events";
import { writeChange } from "./history";
import { applyReview } from "./review";
import { factsOf, loadStored, lockActivity } from "./store";

/** Activities per transaction: each holds an advisory lock until commit, and Postgres's shared lock table is finite. */
export const BATCH_SIZE = 100;

function batchesOf<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) out.push(items.slice(i, i + BATCH_SIZE));
  return out;
}

export interface ReviewSelectedResult {
  reviewed: number[];
  skipped: { id: number; reason: "changed" | "not_found" }[];
  /**
   * A later batch's transaction threw and rolled back after earlier batches had already
   * committed. The route answers 207 (not a bare 500) so the caller can tell `reviewed` and
   * `skipped` are only what ran before the failure, not the whole request.
   */
  failed?: true;
}

/** The list's Review selected (spec addendum §7.1): rows changed since the list loaded are skipped and reported. */
export async function reviewSelected(deps: ApiDeps, actor: CalendarActor, items: { id: number; version: number }[]): Promise<ReviewSelectedResult> {
  if (!can.reviewSelected(actor)) throw new ActivityForbiddenError("HQ Administrators review selected activities");
  const reviewed: number[] = [];
  const skipped: { id: number; reason: "changed" | "not_found" }[] = [];
  // Ascending ids: two bulk actions over overlapping rows lock them in the same order.
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const order = new Map(items.map((it, n) => [it.id, n]));
  const byOriginalOrder = (xs: typeof skipped) => xs.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  for (const [n, batch] of batchesOf(sorted).entries()) {
    // Held in a local scope: a batch that throws rolls its whole transaction back, so nothing
    // it collected here is real until the transaction promise resolves.
    const batchReviewed: number[] = [];
    const batchSkipped: typeof skipped = [];
    try {
      await deps.db.transaction(async (tx) => {
        const now = await dbNow(tx, deps.now);
        for (const item of batch) {
          await lockActivity(tx, item.id);
          const s = await loadStored(tx, item.id, { forUpdate: true });
          if (!s || !visible(actor, factsOf(s))) batchSkipped.push({ id: item.id, reason: "not_found" });
          else if (s.row.version !== item.version) batchSkipped.push({ id: item.id, reason: "changed" });
          else {
            await applyReview(tx, deps, actor, s, now);
            batchReviewed.push(item.id);
          }
        }
      });
    } catch (e) {
      // Nothing has committed yet: the request failed as a whole, and the usual error mapping applies.
      if (n === 0) throw e;
      console.error("[calendar] review-selected: a batch failed after earlier ones committed", safeErrorLabel(e));
      return { reviewed, skipped: byOriginalOrder(skipped), failed: true };
    }
    reviewed.push(...batchReviewed);
    skipped.push(...batchSkipped);
  }
  return { reviewed, skipped: byOriginalOrder(skipped) };
}

export interface ClearLaStatusResult {
  cleared: number;
  /** As with `ReviewSelectedResult.failed`: a later batch failed after earlier ones committed. */
  failed?: true;
}

/**
 * Clears the LA status of every activity the caller can see that starts by 00:00 BC on today + N
 * days, past ones included, as legacy (ActivityHandler.ashx.cs:1258-1274). One history entry each.
 */
export async function clearLaStatus(deps: ApiDeps, actor: CalendarActor, days: number): Promise<ClearLaStatusResult> {
  if (!can.clearLaStatus(actor)) throw new ActivityForbiddenError("HQ clears the LA status");
  const now = await dbNow(deps.db, deps.now);
  const cutoff = bcMidnight(addDays(wallClock(now, deps.rules.timeZone).date, days), deps.rules.timeZone);
  const candidates = await deps.db
    .select({ id: activities.id })
    .from(activities)
    .where(and(visibleSql(actor), isNotNull(activities.hqStatus), lte(activities.startAt, cutoff)))
    .orderBy(asc(activities.id));
  let cleared = 0;
  for (const [n, batch] of batchesOf(candidates.map((c) => c.id)).entries()) {
    let batchCleared = 0;
    try {
      await deps.db.transaction(async (tx) => {
        for (const id of batch) {
          await lockActivity(tx, id);
          const s = await loadStored(tx, id, { forUpdate: true });
          // Re-check under the lock: someone may have changed it since the candidates were read.
          if (!s || !visible(actor, factsOf(s)) || s.row.hqStatus === null || !s.row.startAt || s.row.startAt > cutoff) continue;
          await tx.update(activities).set({ hqStatus: null, version: s.row.version + 1 }).where(eq(activities.id, id));
          await writeChange(tx, {
            activityId: id, actor, action: "la_status_cleared", contactMinistryKey: s.row.contactMinistryKey, at: now,
            fields: [{ key: "hq_status", old: s.row.hqStatus === "new" ? "New" : "Changed", new: null }],
          });
          await emitActivity(tx, deps, id, "activity.updated");
          batchCleared++;
        }
      });
    } catch (e) {
      if (n === 0) throw e;
      console.error("[calendar] clear-la-status: a batch failed after earlier ones committed", safeErrorLabel(e));
      return { cleared, failed: true };
    }
    cleared += batchCleared;
  }
  return { cleared };
}
