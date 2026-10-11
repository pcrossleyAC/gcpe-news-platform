import { LEVEL } from "./levels";

/** M(u), HQ(u) and L(u) of spec addendum §6. The Calendar's actor is one; so is NRMS's Calendar viewer. */
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

/**
 * Whether `ministryKey` is one of the viewer's ministries, byte for byte. Visibility, create and
 * edit rights all read ministry ownership from here.
 */
export const isOwnMinistry = (u: Viewer, ministryKey: string): boolean => u.ministryKeys.includes(ministryKey);

// Legacy's list rule (ActivityListProvider.ashx.cs:214-244, ActivityDAO.cs:261-291). Deleted
// activities are for HQ Administrators to review (ActivityDAO.cs:176-193). Cross-government
// doesn't widen it. Keys compare byte for byte.
export const seesConfidentialEverywhere = (u: Viewer): boolean => u.isHq && u.level >= LEVEL.advanced;
export const seesDeleted = (u: Viewer): boolean => u.isHq && u.level >= LEVEL.administrator;

/** The one visibility rule (spec addendum §6). The Calendar's SQL form is `visibleSql` (apps/calendar/src/visibility.ts). */
export function visible(u: Viewer, a: VisibilityFacts): boolean {
  if (u.level < LEVEL.readOnly) return false;
  const mine = (a.contactMinistryKey !== null && isOwnMinistry(u, a.contactMinistryKey)) || a.sharedMinistryKeys.some((k) => isOwnMinistry(u, k));
  const inScope = u.isHq || mine;
  const seesConfidential = seesConfidentialEverywhere(u) || mine;
  return inScope && (!a.isConfidential || seesConfidential) && (!a.isDeleted || seesDeleted(u));
}
