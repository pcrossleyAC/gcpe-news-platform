import { NEEDS_REVIEW_KEYS, type NeedsReviewKey } from "@gcpe/calendar-contract";

/** The values legacy's save compared (Activity.aspx.cs:1129-1265, ActivityManager.cs:97-254). */
export interface ReviewSnapshot {
  title: string;
  details: string;
  governmentRepresentativeId: number | null;
  cityId: number | null;
  otherCity: string;
  startAt: number | null;
  endAt: number | null;
  potentialDates: string;
  categoryIds: number[];
  isIssue: boolean;
  isConfidential: boolean;
  commMaterialIds: number[];
  significance: string;
  comments: string;
  schedule: string;
  strategy: string;
  leadOrganization: string;
  venue: string;
  initiativeIds: number[];
  keywordIds: number[];
  nrOriginIds: number[];
  translations: string[];
  premierRequestedId: number | null;
  nrDistributionId: number | null;
  eventPlannerId: number | null;
  videographerId: number | null;
  isConfirmed: boolean;
  isAllDay: boolean;
  isCrossGovernment: boolean;
}

const sameText = (a: string, b: string) => a.trim() === b.trim();
const sameSet = <T>(a: readonly T[], b: readonly T[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};
/** "To a new non-empty value": legacy compared only when the dropdown had a value (Activity.aspx.cs:1153-1167). */
const newValue = (before: number | null, after: number | null) => after !== null && after !== before;

/** Which flags a save raises, and whether the status becomes `changed`. Any saving user, HQ included. */
export function reviewChanges(b: ReviewSnapshot, a: ReviewSnapshot): { flags: NeedsReviewKey[]; statusChanged: boolean } {
  const flags = new Set<NeedsReviewKey>();
  let status = false;
  const raise = (changed: boolean, flag: NeedsReviewKey | null, setsStatus = true) => {
    if (!changed) return;
    if (flag) flags.add(flag);
    if (setsStatus) status = true;
  };
  raise(!sameText(b.title, a.title), "title");
  raise(!sameText(b.details, a.details), "details");
  raise(b.governmentRepresentativeId !== a.governmentRepresentativeId, "representative");
  raise(b.cityId !== a.cityId || !sameText(b.otherCity, a.otherCity), "city");
  raise(b.startAt !== a.startAt, "start_date");
  raise(!sameText(b.potentialDates, a.potentialDates), "start_date");
  raise(b.endAt !== a.endAt, "end_date");
  raise(!sameSet(b.categoryIds, a.categoryIds) || b.isIssue !== a.isIssue || b.isConfidential !== a.isConfidential, "categories");
  raise(!sameSet(b.commMaterialIds, a.commMaterialIds), "comm_materials");
  raise(!sameText(b.significance, a.significance), "significance");
  raise(!sameText(b.comments, a.comments), "internal_notes");
  raise(!sameText(b.schedule, a.schedule), "scheduling_considerations");
  raise(!sameText(b.strategy, a.strategy), "strategy");
  raise(!sameText(b.leadOrganization, a.leadOrganization), "lead_organization");
  raise(!sameText(b.venue, a.venue), "venue");
  raise(!sameSet(b.initiativeIds, a.initiativeIds), "initiatives");
  // Legacy compared only the counts (Activity.aspx.cs:1178), so swapping one tag raised nothing (C130).
  raise(!sameSet(b.keywordIds, a.keywordIds), "tags");
  raise(!sameSet(b.nrOriginIds, a.nrOriginIds), "origin");
  raise(!sameSet(b.translations.map((t) => t.trim()), a.translations.map((t) => t.trim())), "translations_required");
  raise(newValue(b.premierRequestedId, a.premierRequestedId), "premier_requested");
  raise(b.premierRequestedId !== a.premierRequestedId, null);
  raise(newValue(b.nrDistributionId, a.nrDistributionId), "distribution");
  raise(b.nrDistributionId !== a.nrDistributionId, null);
  // Event planner and Digital: a new value flags and changes status; clearing does neither.
  raise(newValue(b.eventPlannerId, a.eventPlannerId), "event_planner");
  raise(newValue(b.videographerId, a.videographerId), "digital");
  raise(b.isConfirmed !== a.isConfirmed || b.isAllDay !== a.isAllDay || b.isCrossGovernment !== a.isCrossGovernment, null);
  return { flags: NEEDS_REVIEW_KEYS.filter((k) => flags.has(k)), statusChanged: status };
}

/** The union, each key once, in the 23-key order: the column's CHECK bounds the set but doesn't de-duplicate it. */
export function mergeNeedsReview(current: readonly string[], add: readonly NeedsReviewKey[]): NeedsReviewKey[] {
  const all = new Set<string>([...current, ...add]);
  return NEEDS_REVIEW_KEYS.filter((k) => all.has(k));
}

/** Review clears every flag but `active`, which only a Review of a deleted activity clears (ActivityManager.cs:21-75). */
export const REVIEW_CLEARED_KEYS: readonly NeedsReviewKey[] = NEEDS_REVIEW_KEYS.filter((k) => k !== "active");
