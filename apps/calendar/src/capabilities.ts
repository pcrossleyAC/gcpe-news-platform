import { LEVEL, type CalendarRules } from "@gcpe/calendar-contract";
import { isOwnMinistry, visible, type Viewer, type VisibilityFacts } from "./visibility";

export { isOwnMinistry };
/** Whether the activity's contact ministry is the viewer's. Shared-with ministries don't count. */
export const ownsContactMinistry = (u: Viewer, a: VisibilityFacts): boolean => a.contactMinistryKey !== null && isOwnMinistry(u, a.contactMinistryKey);
/** Legacy's "HQAdmin ministry at Editor and above" privileges, now the HQ flag (C124). */
const hqEditor = (u: Viewer) => u.isHq && u.level >= LEVEL.editor;

/** Spec addendum §6's capability table. Every route checks these on the server (C138–C141). */
export const can = {
  /** Activity.aspx.cs:390-410: their ministries, or any ministry for HQ. Whether the ministry is active is checked where references resolve. */
  create: (u: Viewer, ministryKey: string) => u.level >= LEVEL.editor && (u.isHq || isOwnMinistry(u, ministryKey)),
  /** Activity.aspx.cs:1651-1683: shared-with ministries view only. A deleted activity is read-only. */
  edit: (u: Viewer, a: VisibilityFacts) => !a.isDeleted && visible(u, a) && u.level >= LEVEL.editor && (u.isHq || ownsContactMinistry(u, a)),
  clone: (u: Viewer, a: VisibilityFacts) => can.edit(u, a),
  /** Activity.aspx.cs:1537-1544. */
  delete: (u: Viewer, a: VisibilityFacts) => can.edit(u, a) && u.level >= LEVEL.administrator,
  /** Activity.aspx.cs:1685-1686. */
  review: (u: Viewer, a: VisibilityFacts) => visible(u, a) && u.isHq && u.level >= LEVEL.advanced,
  /** UCFlexiGrid.ascx.cs:21-27 (C139). */
  reviewSelected: (u: Viewer) => u.isHq && u.level >= LEVEL.administrator,
  /** Default.aspx.cs:44-53 (C139). */
  clearLaStatus: (u: Viewer) => hqEditor(u),
  transfer: (u: Viewer) => u.level >= LEVEL.administrator,
  seeLookAheadFieldset: (u: Viewer, rules: Pick<CalendarRules, "showHqCommentsField">, a?: VisibilityFacts) =>
    hqEditor(u) || (rules.showHqCommentsField && (a ? can.edit(u, a) : u.level >= LEVEL.editor)),
  seeNeedsReviewMarkup: (u: Viewer) => hqEditor(u),
  /** Details, Significance and Scheduling aren't required of HQ (Activity.aspx.cs:224-230). */
  relaxRequiredFields: (u: Viewer) => hqEditor(u),
  /** The inactive "HQ Placeholder" category is offered to HQ (DropDownListManager.cs:297). */
  useHqPlaceholder: (u: Viewer) => hqEditor(u),
  /** Spec addendum §7.4: HQ at Editor and above. */
  skipFreeze: (u: Viewer) => hqEditor(u),
} as const;
