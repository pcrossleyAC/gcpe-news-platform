import { inArray, sql, type SQL } from "drizzle-orm";
import { LEVEL, seesConfidentialEverywhere, seesDeleted, type Viewer } from "@gcpe/calendar-contract";
import { activities, activitySharedWith } from "./db/schema";

// The rule itself is shared with NRMS (Forecast and the activity lookup), so it lives in the contract.
export { isOwnMinistry, visible, type Viewer, type VisibilityFacts } from "@gcpe/calendar-contract";

/**
 * The same rule as a predicate over the `activities` table, unaliased: every reader filters in SQL,
 * never in memory after paging (spec addendum §6). The viewer's facts are constants, so each
 * branch is decided here and only the activity's facts are left to Postgres. It is always true or
 * false, never NULL, so it can be negated or selected as a column.
 * Use it only where `activities` appears under its own name, not an alias: it names that table directly.
 */
export function visibleSql(u: Viewer): SQL {
  if (u.level < LEVEL.readOnly) return sql`false`;
  const keys = [...u.ministryKeys];
  const mine =
    keys.length === 0
      ? sql`false`
      : sql`coalesce(${inArray(activities.contactMinistryKey, keys)} OR EXISTS (SELECT 1 FROM ${activitySharedWith} WHERE ${activitySharedWith.activityId} = ${activities.id} AND ${inArray(activitySharedWith.ministryKey, keys)}), false)`;
  const inScope = u.isHq ? sql`true` : mine;
  const seesConfidential = seesConfidentialEverywhere(u) ? sql`true` : mine;
  const deletedOk = seesDeleted(u) ? sql`true` : sql`false`;
  return sql`(${inScope} AND (NOT ${activities.isConfidential} OR ${seesConfidential}) AND (${activities.deletedAt} IS NULL OR ${deletedOk}))`;
}
