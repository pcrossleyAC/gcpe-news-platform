import { and, eq, sql } from "drizzle-orm";
import { sqlNow, type Db, type TestClock, type Tx } from "@gcpe/db-kit";
import type { CalendarRules } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activityLocks } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow, wallClock } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityLockedError, ActivityNotFoundError } from "./errors";
import { factsOf, liveLockOf, loadStored, lockActivity, LOCK_IDLE_MS, type LiveLock } from "./store";

export interface LockView {
  holderName: string;
  since: string;
  mine: true;
  tabId: string;
}

function lockedBy(l: LiveLock, rules: CalendarRules): ActivityLockedError {
  return new ActivityLockedError("locked", `${l.holderName} is editing this activity (since ${wallClock(l.acquiredAt, rules.timeZone).time})`, {
    displayName: l.holderName,
    since: l.acquiredAt.toISOString(),
  });
}

/**
 * Takes the lock, refreshes it (the editor's heartbeat), or with takeOver moves the caller's own
 * lock to this tab ("Continue here"). Never takes another user's live lock (spec addendum §7.5).
 */
export async function takeLock(deps: ApiDeps, actor: CalendarActor, id: number, tabId: string, takeOver: boolean): Promise<LockView> {
  return deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.edit(actor, factsOf(s))) throw new ActivityForbiddenError("You can't edit this activity");
    assertNotFrozen(await dbNow(tx, deps.now), actor, deps.rules);
    const live = await liveLockOf(tx, id, deps.now, { forUpdate: true });
    if (live && live.userId !== actor.userId) throw lockedBy(live, deps.rules);
    if (live && live.tabId !== tabId && !takeOver) {
      throw new ActivityLockedError("locked_elsewhere", "You're editing this activity in another tab", { displayName: live.holderName, since: live.acquiredAt.toISOString() });
    }
    const at = sqlNow(deps.now);
    if (live) {
      await tx.update(activityLocks).set({ tabId, lastActiveAt: at }).where(eq(activityLocks.activityId, id));
    } else {
      // No row, or a lapsed one the sweep hasn't reached yet.
      const fresh = { userId: actor.userId, tabId, acquiredAt: at, lastActiveAt: at };
      await tx.insert(activityLocks).values({ activityId: id, ...fresh }).onConflictDoUpdate({ target: activityLocks.activityId, set: fresh });
    }
    const [row] = await tx.select().from(activityLocks).where(eq(activityLocks.activityId, id));
    return { holderName: actor.displayName, since: row!.acquiredAt.toISOString(), mine: true, tabId };
  });
}

/** Only the holder's own tab releases: legacy's cancel deleted whoever's lock it found (C128). */
export async function releaseLock(deps: ApiDeps, actor: CalendarActor, id: number, tabId: string): Promise<void> {
  await deps.db.delete(activityLocks).where(and(eq(activityLocks.activityId, id), eq(activityLocks.userId, actor.userId), eq(activityLocks.tabId, tabId)));
}

/** Saving or deleting while someone else holds a live lock is refused (spec addendum §7.5). */
export async function assertNotLockedByOther(tx: Tx, deps: ApiDeps, actor: CalendarActor, id: number): Promise<void> {
  const live = await liveLockOf(tx, id, deps.now, { forUpdate: true });
  if (live && live.userId !== actor.userId) throw lockedBy(live, deps.rules);
}

/** A save releases the saver's lock, whichever tab holds it. */
export async function releaseOwnLocks(tx: Tx, userId: string, id: number): Promise<void> {
  await tx.delete(activityLocks).where(and(eq(activityLocks.activityId, id), eq(activityLocks.userId, userId)));
}

export async function clearLocks(tx: Tx, id: number): Promise<void> {
  await tx.delete(activityLocks).where(eq(activityLocks.activityId, id));
}

/** The tick's sweep: deletes every lock idle for 15 minutes or more. */
export async function sweepLocks(db: Db, clock?: TestClock): Promise<{ deleted: number }> {
  const r = await db.execute(sql`DELETE FROM ${activityLocks} WHERE ${activityLocks.lastActiveAt} <= ${sqlNow(clock)} - ${sql.raw(`interval '${LOCK_IDLE_MS / 60_000} minutes'`)}`);
  return { deleted: r.rowCount ?? 0 };
}
