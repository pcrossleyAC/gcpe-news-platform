import { describe, expect, it } from "vitest";
import { EDITOR_RULE_KEYS, editorRulesOf, releaseFieldsetHidden } from "./editor";
import type { CalendarRules } from "./rules";

const RULES: CalendarRules = {
  timeZone: "America/Vancouver",
  freeze: { start: "16:00", end: "17:00" },
  releaseCategoryIds: [12, 58],
  awarenessCategoryIds: [2],
  otherCityId: 311,
  unconfirmedIssueCommMaterialId: 61,
  hqPlaceholderCategoryName: "Sample HQ placeholder",
  confidentialCategoryName: "Sample confidential category",
  issueExemptCategoryNames: ["Sample approved event"],
  eventsCategoryNames: ["Sample approved event"],
  releaseHiddenCategoryNames: ["Sample no-release category"],
  consultationsMinistryAbbreviation: "CONSULT",
  contactMinistryExcludedAbbreviations: ["EXCL"],
  sharedWithExcludedAbbreviations: ["EXCL"],
  translationsDefault: ["Sample language A"],
  required: { significance: true, scheduling: true, strategy: false },
  showHqCommentsField: false,
  showRecordsSection: false,
  cloneKeptKeywordNames: ["Sample kept keyword"],
  lookAheadCoverImage: null,
  reportBanner: { province: "Sample Province", confidentiality: "DRAFT AND CONFIDENTIAL" },
};

describe("the editor's rules", () => {
  it("are exactly the keys the browser reads, nothing the reports or the server alone use", () => {
    const r = editorRulesOf(RULES);
    expect(Object.keys(r).sort()).toEqual([...EDITOR_RULE_KEYS].sort());
    expect(r).not.toHaveProperty("freeze");
    expect(r).not.toHaveProperty("reportBanner");
    expect(r).not.toHaveProperty("cloneKeptKeywordNames");
    expect(r.releaseHiddenCategoryNames).toEqual(["Sample no-release category"]);
  });

  it("hide the Release fieldset for the tenant's named categories only (activityhelper.ts:170-196)", () => {
    expect(releaseFieldsetHidden("Sample no-release category", RULES)).toBe(true);
    expect(releaseFieldsetHidden("Sample approved event", RULES)).toBe(false);
    expect(releaseFieldsetHidden(null, RULES)).toBe(false);
  });
});
