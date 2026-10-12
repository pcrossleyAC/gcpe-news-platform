import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { siteState } from "./db/schema";

/** The change feed's stored cursor (spec §6.2), null before the first sync. */
export async function readCursor(db: DbOrTx): Promise<number | null> {
  const [row] = await db.select({ c: siteState.changeCursor }).from(siteState).where(eq(siteState.id, 1));
  return row?.c ?? null;
}

export async function saveCursor(db: DbOrTx, cursor: number): Promise<void> {
  await db
    .insert(siteState)
    .values({ id: 1, changeCursor: cursor })
    .onConflictDoUpdate({ target: siteState.id, set: { changeCursor: cursor, updatedAt: sql`now()` } });
}
