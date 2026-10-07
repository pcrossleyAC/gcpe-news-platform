import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { distributionSettings } from "./db/schema";

export async function getSettings(db: Db): Promise<{ paused: boolean }> {
  const [row] = await db.select({ paused: distributionSettings.paused }).from(distributionSettings).where(eq(distributionSettings.id, 1));
  return { paused: row?.paused ?? false };
}

/**
 * The Distribution-wide pause switch (spec §6/§8): sender.ts's claim reads this same row,
 * inside its own transaction, and restricts the claim to system-priority messages while
 * paused — so nothing but verification/manage-link/ops mail goes out, and everything else is
 * held, never dropped.
 *
 * Only the `paused` flag itself lives here -- the audit trail (operations_log) and ops email
 * are NoD's own responsibility (apps/nod/src/settings.ts's setDistributionPaused), one HTTP
 * hop up, since that's where the admin, the log and the ops inbox all already live for NoD's
 * own pause (4b). A no-op call (already in the requested state) changes nothing and reports
 * `changed: false`, so the caller up there knows not to log or email anything either.
 */
export async function setPaused(db: Db, paused: boolean): Promise<{ paused: boolean; changed: boolean }> {
  const [row] = await db
    .update(distributionSettings)
    .set({ paused, updatedAt: sql`now()` })
    .where(and(eq(distributionSettings.id, 1), ne(distributionSettings.paused, paused)))
    .returning({ id: distributionSettings.id });
  return { paused, changed: row !== undefined };
}
