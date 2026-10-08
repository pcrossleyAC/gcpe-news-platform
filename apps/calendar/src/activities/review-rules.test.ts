import { describe, expect, it } from "vitest";
import { NEEDS_REVIEW_KEYS, type NeedsReviewKey } from "@gcpe/calendar-contract";
import { mergeNeedsReview, REVIEW_CLEARED_KEYS, reviewChanges, type ReviewSnapshot } from "./review-rules";

const base: ReviewSnapshot = {
  title: "Sample title", details: "Sample details", governmentRepresentativeId: 1, cityId: 1, otherCity: "",
  startAt: Date.UTC(2026, 10, 10, 17), endAt: Date.UTC(2026, 10, 10, 18), potentialDates: "",
  categoryIds: [32], isIssue: false, isConfidential: false, commMaterialIds: [1],
  significance: "Sample significance", comments: "Sample notes", schedule: "Sample schedule", strategy: "Sample strategy",
  leadOrganization: "Sample org", venue: "Sample venue", initiativeIds: [1], keywordIds: [1, 2], nrOriginIds: [1],
  translations: ["Sample language A"], premierRequestedId: 1, nrDistributionId: 1, eventPlannerId: 1, videographerId: 1,
  isConfirmed: true, isAllDay: false, isCrossGovernment: false,
};

/** Spec addendum §7.3, one row per change. `flag: null` is "none". */
const TRIGGER_TABLE: { change: string; apply: (s: ReviewSnapshot) => Partial<ReviewSnapshot>; flag: NeedsReviewKey | null; status: boolean }[] = [
  { change: "Title", apply: (s) => ({ title: `${s.title} changed` }), flag: "title", status: true },
  { change: "Details", apply: () => ({ details: "Other details" }), flag: "details", status: true },
  { change: "Representative", apply: () => ({ governmentRepresentativeId: 2 }), flag: "representative", status: true },
  { change: "Representative cleared", apply: () => ({ governmentRepresentativeId: null }), flag: "representative", status: true },
  { change: "City", apply: () => ({ cityId: 2 }), flag: "city", status: true },
  { change: "Other City", apply: () => ({ otherCity: "Sample place" }), flag: "city", status: true },
  { change: "Start", apply: (s) => ({ startAt: s.startAt! + 3_600_000 }), flag: "start_date", status: true },
  { change: "Potential Dates", apply: () => ({ potentialDates: "late spring" }), flag: "start_date", status: true },
  { change: "End", apply: (s) => ({ endAt: s.endAt! + 3_600_000 }), flag: "end_date", status: true },
  { change: "Category", apply: () => ({ categoryIds: [30] }), flag: "categories", status: true },
  { change: "Issue", apply: () => ({ isIssue: true }), flag: "categories", status: true },
  { change: "Confidential", apply: () => ({ isConfidential: true }), flag: "categories", status: true },
  { change: "Comm materials", apply: () => ({ commMaterialIds: [1, 61] }), flag: "comm_materials", status: true },
  { change: "Significance", apply: () => ({ significance: "Other significance" }), flag: "significance", status: true },
  { change: "Internal notes", apply: () => ({ comments: "Other notes" }), flag: "internal_notes", status: true },
  { change: "Scheduling", apply: () => ({ schedule: "Other schedule" }), flag: "scheduling_considerations", status: true },
  { change: "Strategy", apply: () => ({ strategy: "Other strategy" }), flag: "strategy", status: true },
  { change: "Lead organization", apply: () => ({ leadOrganization: "Other org" }), flag: "lead_organization", status: true },
  { change: "Venue", apply: () => ({ venue: "Other venue" }), flag: "venue", status: true },
  { change: "Initiatives", apply: () => ({ initiativeIds: [] }), flag: "initiatives", status: true },
  { change: "HQ Tags: the set changes, count unchanged (C130)", apply: () => ({ keywordIds: [1, 3] }), flag: "tags", status: true },
  { change: "HQ Tags: one added", apply: () => ({ keywordIds: [1, 2, 3] }), flag: "tags", status: true },
  { change: "NR Origin", apply: () => ({ nrOriginIds: [2] }), flag: "origin", status: true },
  { change: "NR Origin to empty", apply: () => ({ nrOriginIds: [] }), flag: "origin", status: true },
  { change: "Translations", apply: () => ({ translations: ["Sample language A", "Sample language B"] }), flag: "translations_required", status: true },
  { change: "Premier Requested to a new non-empty value", apply: () => ({ premierRequestedId: 2 }), flag: "premier_requested", status: true },
  { change: "Premier Requested cleared", apply: () => ({ premierRequestedId: null }), flag: null, status: true },
  { change: "NR Distribution to a new non-empty value", apply: () => ({ nrDistributionId: 2 }), flag: "distribution", status: true },
  { change: "NR Distribution cleared", apply: () => ({ nrDistributionId: null }), flag: null, status: true },
  { change: "Event planner to a new non-empty value", apply: () => ({ eventPlannerId: 2 }), flag: "event_planner", status: true },
  { change: "Digital to a new non-empty value", apply: () => ({ videographerId: 2 }), flag: "digital", status: true },
  { change: "Event planner cleared", apply: () => ({ eventPlannerId: null }), flag: null, status: false },
  { change: "Digital cleared", apply: () => ({ videographerId: null }), flag: null, status: false },
  { change: "Dates Confirmed", apply: () => ({ isConfirmed: false }), flag: null, status: true },
  { change: "All Day", apply: () => ({ isAllDay: true }), flag: null, status: true },
  { change: "Cross-Government", apply: () => ({ isCrossGovernment: true }), flag: null, status: true },
];
// The table's last two rows (the fields that set nothing, and Delete) aren't snapshot fields: the
// update and delete route tests pin them through the API.

describe("needs-review and status, legacy's trigger table row by row (spec addendum §7.3)", () => {
  it.each(TRIGGER_TABLE)("$change → flag $flag, status changed: $status", ({ apply, flag, status }) => {
    const after = { ...base, ...apply(base) };
    expect(reviewChanges(base, after)).toEqual({ flags: flag ? [flag] : [], statusChanged: status });
  });

  it("covers every flag a save can raise: all 23 but active", () => {
    const raised = new Set(TRIGGER_TABLE.map((r) => r.flag).filter(Boolean));
    expect([...raised].sort()).toEqual(NEEDS_REVIEW_KEYS.filter((k) => k !== "active").sort());
  });

  it("a save that changes nothing raises nothing", () => expect(reviewChanges(base, { ...base })).toEqual({ flags: [], statusChanged: false }));

  it("text compares trimmed; lists compare as sets", () => {
    const after = { ...base, title: ` ${base.title} `, significance: `${base.significance}\n`, keywordIds: [2, 1], translations: [...base.translations] };
    expect(reviewChanges(base, after)).toEqual({ flags: [], statusChanged: false });
  });

  it("any combination of rows raises exactly the union of their flags (seeded generator, 300 cases)", () => {
    let seed = 20261101;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 300; n++) {
      const rows = TRIGGER_TABLE.filter(() => rand() < 0.2);
      const after = rows.reduce((s, r) => ({ ...s, ...r.apply(base) }), { ...base });
      // Two rows can write one field ("Premier Requested cleared" after "…to a new value"): only the
      // rows whose values are the ones finally saved count.
      const effective = rows.filter((r) => Object.entries(r.apply(base)).every(([k, v]) => JSON.stringify((after as Record<string, unknown>)[k]) === JSON.stringify(v)));
      const result = reviewChanges(base, after);
      expect([...result.flags].sort()).toEqual([...new Set(effective.map((r) => r.flag).filter((f): f is NeedsReviewKey => f !== null))].sort());
      expect(result.statusChanged).toBe(effective.some((r) => r.status));
    }
  });
});

describe("the needs_review set", () => {
  it("never holds a key twice, and keeps the 23-key order", () => {
    expect(mergeNeedsReview(["title", "details"], ["details", "title", "tags", "tags"])).toEqual(["title", "details", "tags"]);
    expect(mergeNeedsReview(["active", "title"], ["active"])).toEqual(["title", "active"]);
  });
  it("Review clears 22 keys, never active", () => {
    expect(REVIEW_CLEARED_KEYS).toHaveLength(22);
    expect(REVIEW_CLEARED_KEYS).not.toContain("active");
  });
});
