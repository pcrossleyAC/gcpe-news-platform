import { describe, expect, it } from "vitest";
import { checkActivity, inferLookAhead, type ActivityFields, type EditorOptions } from "@gcpe/calendar-contract";
import { CONFIG, HQ_ADMIN_ME, ME } from "../list/fixtures";
import {
  bodyOf, categoryChoices, commContactChoices, errorsByField, fieldId, initialOverride, inferredLabel, leadMinistryChoices, lookAheadInputOf, lookupChoices,
  needsReviewOf, newActivityFields, sharedWithChoices, translationChoices, withAllDay, withCategory, withInferredSection, withMinistry,
} from "./form";

const RULES = CONFIG.rules;
const O: EditorOptions = {
  categories: [
    { id: 32, name: "Sample category", isActive: true }, { id: 2, name: "Sample awareness", isActive: true },
    { id: 33, name: "Sample HQ placeholder", isActive: false }, { id: 34, name: "Sample retired category", isActive: false },
  ],
  cities: [{ id: 1, name: "Sample City", isActive: true }, { id: 9, name: "Sample Old City", isActive: false }],
  commMaterials: [], eventPlanners: [], representatives: [], initiatives: [], keywords: [], distributions: [], origins: [], premierRequested: [], videographers: [],
  ministries: [
    { key: "health", abbreviation: "HLTH", name: "Sample Health", isActive: true }, { key: "finance", abbreviation: "FIN", name: "Sample Finance", isActive: true },
    { key: "excluded", abbreviation: "EXCL", name: "Sample Excluded", isActive: true }, { key: "retired", abbreviation: "RET", name: "Sample Retired", isActive: false },
  ],
  commContacts: [
    { id: 11, ministryKey: "health", name: "Robin Staff", rank: 4, isActive: true },
    { id: 12, ministryKey: "finance", name: "Kim Finance", rank: 1, isActive: true },
    { id: 13, ministryKey: "health", name: "Sample Former", rank: null, isActive: false },
  ],
  sectors: [], themes: [], tags: [],
};
const base = (over: Partial<ActivityFields> = {}): ActivityFields => ({ ...newActivityFields(ME, false), categoryId: 32, title: "Sample", startDate: "2031-11-10", endDate: "2031-11-10", ...over });

describe("the editor's form model", () => {
  it("starts a new activity at legacy's 8:00 AM to 6:00 PM, in the user's only ministry", () => {
    const f = newActivityFields(ME, false);
    expect(f).toMatchObject({ startTime: "08:00", endTime: "18:00", contactMinistryKey: "health", isAllDay: false, categoryId: null });
    expect(f).not.toHaveProperty("lookAhead");
    expect(newActivityFields(HQ_ADMIN_ME, true)).toMatchObject({ contactMinistryKey: null, lookAhead: { hqComments: "", hqStatus: null, hqSection: "not_on_la", longTermOutlook: false } });
  });

  it("offers active rows, plus the inactive value the activity already holds, marked", () => {
    expect(lookupChoices(O.cities, [null])).toEqual([{ value: "1", label: "Sample City" }]);
    expect(lookupChoices(O.cities, [9])).toEqual([{ value: "1", label: "Sample City" }, { value: "9", label: "Sample Old City (no longer in use)" }]);
  });

  it("offers HQ Placeholder to HQ only, and keeps a retired category the activity has", () => {
    expect(categoryChoices(O, RULES, false, null).map((c) => c.label)).toEqual(["Sample category", "Sample awareness"]);
    expect(categoryChoices(O, RULES, true, null).map((c) => c.label)).toEqual(["Sample category", "Sample awareness", "Sample HQ placeholder"]);
    expect(categoryChoices(O, RULES, false, 34).map((c) => c.label)).toContain("Sample retired category (no longer in use)");
  });

  it("lead ministry: one's own for a ministry user, every active one but the excluded for HQ (Activity.aspx.cs:390-410)", () => {
    expect(leadMinistryChoices(O, RULES, ME, null).map((c) => c.value)).toEqual(["health"]);
    expect(leadMinistryChoices(O, RULES, HQ_ADMIN_ME, null).map((c) => c.value)).toEqual(["health", "finance"]);
    expect(leadMinistryChoices(O, RULES, ME, "retired").map((c) => c.label)).toContain("Sample Retired (RET) (no longer in use)");
  });

  it("shared with: every active ministry but the excluded, plus what is already shared", () => {
    expect(sharedWithChoices(O, RULES, []).map((c) => c.value)).toEqual(["health", "finance"]);
    expect(sharedWithChoices(O, RULES, ["retired"]).map((c) => c.value)).toEqual(["health", "finance", "retired"]);
  });

  it("comm contacts: the lead ministry's active ones, named with their rank, plus the current one", () => {
    expect(commContactChoices(O, "health", null)).toEqual([{ value: "11", label: "Robin Staff (PAO)" }]);
    expect(commContactChoices(O, "health", 13).map((c) => c.label)).toEqual(["Robin Staff (PAO)", "Sample Former (no longer in use)"]);
    expect(commContactChoices(O, null, null)).toEqual([]);
  });

  it("translations: the tenant's list, plus any other the activity has", () => {
    expect(translationChoices(RULES.translationsDefault, ["Sample other language"]).map((c) => c.value)).toEqual(["Sample language A", "Sample language B", "Sample other language"]);
  });

  it("a category that hides the Release fieldset clears the release time (activityhelper.ts:170-196)", () => {
    expect(withCategory(base({ nrDate: "2031-11-10", nrTime: "09:00" }), 2, O, RULES)).toMatchObject({ categoryId: 2, nrDate: null, nrTime: null });
    expect(withCategory(base({ nrDate: "2031-11-10", nrTime: "09:00" }), 32, O, RULES)).toMatchObject({ nrDate: "2031-11-10", nrTime: "09:00" });
  });

  it("a new lead ministry drops another ministry's comm contact", () => {
    expect(withMinistry(base({ commContactId: 11 }), "finance", O).commContactId).toBeNull();
    expect(withMinistry(base({ commContactId: 12 }), "finance", O).commContactId).toBe(12);
  });

  it("turning All Day off brings the default times back where they were empty", () => {
    expect(withAllDay(base({ isAllDay: true, startTime: null, endTime: null }), false)).toMatchObject({ isAllDay: false, startTime: "08:00", endTime: "18:00" });
  });

  it("the Look Ahead section follows the inference until it is overridden (spec addendum §7.6)", () => {
    const f = { ...base({ isConfirmed: true }), lookAhead: { hqComments: "", hqStatus: null, hqSection: "not_on_la" as const, longTermOutlook: false } };
    expect(withInferredSection(f, false, O, RULES, null).lookAhead!.hqSection).toBe("in_the_news");
    expect(withInferredSection({ ...f, isIssue: true }, false, O, RULES, null).lookAhead!.hqSection).toBe("issues_and_reports");
    expect(withInferredSection(f, true, O, RULES, null).lookAhead!.hqSection).toBe("not_on_la");
    const awareness = { ...f, categoryId: 2 };
    expect(inferLookAhead(lookAheadInputOf(awareness, O, "in_the_news"), RULES)).toEqual({ kind: "awareness" });
    expect(withInferredSection(awareness, false, O, RULES, "in_the_news").lookAhead!.hqSection).toBe("not_on_la");
    expect(inferredLabel({ kind: "awareness" })).toBe("Awareness Dates");
    expect(initialOverride("not_on_la", { kind: "section", section: "in_the_news" })).toBe(true);
    expect(initialOverride("in_the_news", { kind: "section", section: "in_the_news" })).toBe(false);
    expect(initialOverride("in_the_news", { kind: "awareness" })).toBe(false);
  });

  it("sends the Look Ahead fields only from someone who sees them (spec addendum §6)", () => {
    const f = { ...base(), lookAhead: { hqComments: "x", hqStatus: null, hqSection: "not_on_la" as const, longTermOutlook: false } };
    expect(bodyOf(f, false)).not.toHaveProperty("lookAhead");
    expect(bodyOf(f, true).lookAhead).toEqual(f.lookAhead);
  });

  it("marks fields by legacy's needs-review flags", () => {
    expect(needsReviewOf("potentialDates", ["start_date"])).toBe(true);
    expect(needsReviewOf("otherCity", ["city"])).toBe(true);
    expect(needsReviewOf("keywordNames", ["tags"])).toBe(true);
    expect(needsReviewOf("title", ["details"])).toBe(false);
  });

  it("runs the server's own rules, and groups their messages by field for the form", () => {
    const errors = checkActivity(base({ title: " ", categoryId: 12 }), { rules: RULES, relaxRequired: false, lookAheadFieldset: false, previous: null, inferredSection: null });
    const byField = errorsByField(errors);
    expect(byField.get("title")).toEqual(["Enter a title"]);
    expect(byField.get("nrOriginId")).toEqual(["Choose the origin: this category is a release"]);
    expect(fieldId("lookAhead.hqComments")).toBe("activity-lookAhead-hqComments");
  });
});
