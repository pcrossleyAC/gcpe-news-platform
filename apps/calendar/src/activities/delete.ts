import { eq } from "drizzle-orm";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, VersionConflictError } from "./errors";
import { emitActivityDeleted } from "./events";
import { writeChange } from "./history";
import { assertNotLockedByOther, clearLocks } from "./locks";
import { mergeNeedsReview } from "./review-rules";
import { factsOf, loadStored, lockActivity } from "./store";

/** Spec addendum §7.1 Delete (ActivityManager.cs:77-92): deleted_at and the `active` flag, for HQ to review. */
export async function deleteActivity(deps: ApiDeps, actor: CalendarActor, id: number, version: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.delete(actor, factsOf(s))) throw new ActivityForbiddenError("Administrators of the lead ministry, and HQ Administrators, delete activities");
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, deps.rules);
    await assertNotLockedByOther(tx, deps, actor, id);
    if (s.row.version !== version) throw new VersionConflictError();
    await tx
      .update(activities)
      .set({ deletedAt: now, deletedBy: actor.userId, needsReview: mergeNeedsReview(s.row.needsReview, ["active"]), version: s.row.version + 1 })
      .where(eq(activities.id, id));
    await clearLocks(tx, id);
    await writeChange(tx, { activityId: id, actor, action: "deleted", contactMinistryKey: s.row.contactMinistryKey, at: now, fields: [] });
    await emitActivityDeleted(tx, deps, id);
  });
}
