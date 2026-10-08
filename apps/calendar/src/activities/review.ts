import { eq } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import type { ActivityStatus } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityForbiddenError, ActivityNotFoundError, VersionConflictError } from "./errors";
import { emitActivity } from "./events";
import { writeChange } from "./history";
import { REVIEW_CLEARED_KEYS } from "./review-rules";
import { factsOf, loadStored, lockActivity, type StoredActivity } from "./store";

const STATUS_LABEL: Record<ActivityStatus, string> = { new: "New", changed: "Changed", reviewed: "Reviewed" };

/**
 * HQ's review (ActivityManager.cs:21-75): a live activity becomes `reviewed` with every flag but
 * `active` cleared; a deleted one only has `active` cleared. The caller holds the activity's lock.
 */
export async function applyReview(tx: Tx, deps: ApiDeps, actor: CalendarActor, s: StoredActivity, now: Date): Promise<void> {
  const deleted = s.row.deletedAt !== null;
  const needsReview = deleted ? s.row.needsReview.filter((k) => k !== "active") : s.row.needsReview.filter((k) => !REVIEW_CLEARED_KEYS.includes(k));
  const status: ActivityStatus = deleted ? s.row.status : "reviewed";
  await tx.update(activities).set({ needsReview, status, version: s.row.version + 1 }).where(eq(activities.id, s.row.id));
  await writeChange(tx, {
    activityId: s.row.id, actor, action: "reviewed", contactMinistryKey: s.row.contactMinistryKey, at: now,
    fields: s.row.status === status ? [] : [{ key: "status", old: STATUS_LABEL[s.row.status], new: STATUS_LABEL[status] }],
  });
  await emitActivity(tx, deps, s.row.id, "activity.updated");
}

/** Review from the activity page: HQ Advanced and above, version-checked; it ignores edit locks. */
export async function reviewActivity(deps: ApiDeps, actor: CalendarActor, id: number, version: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (!can.review(actor, factsOf(s))) throw new ActivityForbiddenError("HQ reviews activities");
    if (s.row.version !== version) throw new VersionConflictError();
    await applyReview(tx, deps, actor, s, await dbNow(tx, deps.now));
  });
}
