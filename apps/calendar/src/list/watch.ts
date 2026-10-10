import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { CalendarActor } from "../actor";
import { ActivityNotFoundError } from "../activities/errors";
import { activities, favourites } from "../db/schema";
import { lockUserData } from "../users";
import { visibleSql } from "../visibility";

/** Adds to My Watchlist (legacy FavoriteActivity). Only an activity the caller can see; not frozen. */
export async function watchActivity(db: Db, actor: CalendarActor, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUserData(tx, actor.userId);
    const [a] = await tx.select({ id: activities.id }).from(activities).where(and(eq(activities.id, id), visibleSql(actor)));
    if (!a) throw new ActivityNotFoundError();
    await tx.insert(favourites).values({ userId: actor.userId, activityId: id }).onConflictDoNothing();
  });
}

/** Removes from My Watchlist, whether or not the activity is still visible: never a 404, which would say whether it exists. */
export async function unwatchActivity(db: DbOrTx, actor: CalendarActor, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUserData(tx, actor.userId);
    await tx.delete(favourites).where(and(eq(favourites.userId, actor.userId), eq(favourites.activityId, id)));
  });
}
