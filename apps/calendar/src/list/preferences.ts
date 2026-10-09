import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { DEFAULT_HIDDEN_COLUMNS, HIDEABLE_COLUMNS, type HideableColumn, type ListPreferences } from "@gcpe/calendar-contract";
import { userProfiles } from "../db/schema";
import { lockUserData } from "../users";

const isHideable = (c: string): c is HideableColumn => (HIDEABLE_COLUMNS as readonly string[]).includes(c);

/**
 * The user's list display and hidden columns. Both are written together, so a null display means
 * no choice yet: legacy's defaults for both (a contact-details profile holds '{}' for the columns).
 */
export async function readPreferences(db: DbOrTx, userId: string): Promise<ListPreferences> {
  const [p] = await db.select({ display: userProfiles.listDisplay, hidden: userProfiles.hiddenColumns }).from(userProfiles).where(eq(userProfiles.userId, userId));
  if (!p || p.display === null) return { display: "all", hiddenColumns: [...DEFAULT_HIDDEN_COLUMNS] };
  return { display: p.display, hiddenColumns: p.hidden.filter(isHideable) };
}

/** Not frozen (spec addendum §7.4). */
export async function writePreferences(db: DbOrTx, userId: string, p: ListPreferences): Promise<ListPreferences> {
  return db.transaction(async (tx) => {
    await lockUserData(tx, userId);
    const values = { listDisplay: p.display, hiddenColumns: [...p.hiddenColumns].sort(), updatedAt: sql`now()` };
    await tx.insert(userProfiles).values({ userId, ...values }).onConflictDoUpdate({ target: userProfiles.userId, set: values });
    return readPreferences(tx, userId);
  });
}
