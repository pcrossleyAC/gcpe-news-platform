import { inArray, sql, type SQL } from "drizzle-orm";
import { LEVEL } from "@gcpe/calendar-contract";
import { activities, activitySharedWith } from "./db/schema";

/** M(u), HQ(u) and L(u) of spec addendum §6. A CalendarActor is one. */
export interface Viewer {
  level: number;
  isHq: boolean;
  ministryKeys: readonly string[];
}
export interface VisibilityFacts {
  contactMinistryKey: string | null;
  sharedMinistryKeys: readonly string[];
  isConfidential: boolean;
  isDeleted: boolean;
}

// Legacy's list rule (ActivityListProvider.ashx.cs:214-244, ActivityDAO.cs:261-291). Deleted
// activities are for HQ Administrators to review (ActivityDAO.cs:176-193). Cross-government
// doesn't widen it. Keys compare byte for byte.
const seesConfidentialEverywhere = (u: Viewer) => u.isHq && u.level >= LEVEL.advanced;
const seesDeleted = (u: Viewer) => u.isHq && u.level >= LEVEL.administrator;

export function visible(u: Viewer, a: VisibilityFacts): boolean {
  if (u.level < LEVEL.readOnly) return false;
  const mine = (a.contactMinistryKey !== null && u.ministryKeys.includes(a.contactMinistryKey)) || a.sharedMinistryKeys.some((k) => u.ministryKeys.includes(k));
  const inScope = u.isHq || mine;
  const seesConfidential = seesConfidentialEverywhere(u) || mine;
  return inScope && (!a.isConfidential || seesConfidential) && (!a.isDeleted || seesDeleted(u));
}

/**
 * The same rule as a predicate over the `activities` table, unaliased: every reader filters in SQL,
 * never in memory after paging (spec addendum §6). The viewer's facts are constants, so each
 * branch is decided here and only the activity's facts are left to Postgres.
 */
export function visibleSql(u: Viewer): SQL {
  if (u.level < LEVEL.readOnly) return sql`false`;
  const keys = [...u.ministryKeys];
  const mine =
    keys.length === 0
      ? sql`false`
      : sql`(${inArray(activities.contactMinistryKey, keys)} OR EXISTS (SELECT 1 FROM ${activitySharedWith} WHERE ${activitySharedWith.activityId} = ${activities.id} AND ${inArray(activitySharedWith.ministryKey, keys)}))`;
  const inScope = u.isHq ? sql`true` : mine;
  const seesConfidential = seesConfidentialEverywhere(u) ? sql`true` : mine;
  const deletedOk = seesDeleted(u) ? sql`true` : sql`false`;
  return sql`(${inScope} AND (NOT ${activities.isConfidential} OR ${seesConfidential}) AND (${activities.deletedAt} IS NULL OR ${deletedOk}))`;
}
