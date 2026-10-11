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
  reports: {
    cover: { organization: "Sample Communications Office", lines: ["SAMPLE PROVINCE", "CORPORATE LOOK AHEAD"] },
    planningTitle: "Sample Corporate Calendar: Schedule of Activities",
    leadAbbreviations: { FIN: "FN" },
    cityToBeDecidedName: "Sample undecided city",
    citySuffix: ", SP",
    tvRadioCategoryName: "Sample broadcast",
    issueCategoryText: "Sample issue",
    fyiOnlyCategoryText: "Sample FYI only",
    rlsMaterials: [
      { contains: ["Sample news release"], code: "NR" },
      { contains: ["Sample report"], code: "Report", notInEvents: true },
      { contains: ["Sample fact sheet", "Sample factsheet"], code: "Fact Sheet" },
      { contains: ["Sample newsletter"], code: "e-news", notInEvents: true, releaseTime: false },
    ],
    rlsOrigins: [
      { contains: ["Sample origin"], code: "Gov" },
      { contains: ["Sample joint origin"], code: "Joint" },
    ],
  },
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

  it("a category name with doubled or stray whitespace still matches (legacy category 16: 'Speech /  Remarks')", () => {
    expect(releaseFieldsetHidden("Sample  no-release category", RULES)).toBe(true);
    expect(releaseFieldsetHidden(" Sample no-release category ", RULES)).toBe(true);
  });
});
