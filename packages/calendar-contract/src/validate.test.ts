import { describe, expect, it } from "vitest";
import type { ActivityFields } from "./input";
import { checkActivity, warningsFor, type CheckContext } from "./validate";

const ok: ActivityFields = {
  categoryId: 32, title: "Sample activity", details: "Sample summary", significance: "Sample significance", strategy: "", schedule: "Sample scheduling",
  comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
  isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
  startDate: "2026-11-10", startTime: "09:00", endDate: "2026-11-10", endTime: "10:00", nrDate: null, nrTime: null,
  contactMinistryKey: "health", commContactId: 1, governmentRepresentativeId: null, cityId: 1, premierRequestedId: null,
  nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
  commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
};
const ctx: CheckContext = { rules: { releaseCategoryIds: [12, 58], required: { significance: true, scheduling: true, strategy: false } }, relaxRequired: false, lookAheadFieldset: false, previous: null, inferredSection: "in_the_news" };
const fields = (over: Partial<ActivityFields>, c: Partial<CheckContext> = {}) => checkActivity({ ...ok, ...over }, { ...ctx, ...c }).map((e) => e.field);

describe("the editor's rules, on the server too (spec addendum §7.2, C156)", () => {
  it("a complete activity passes", () => expect(fields({})).toEqual([]));

  it.each<[string, Partial<ActivityFields>, string[]]>([
    ["no category", { categoryId: null }, ["categoryId"]],
    ["no lead ministry", { contactMinistryKey: null }, ["contactMinistryKey"]],
    ["a blank title", { title: "   " }, ["title"]],
    ["a title that clean-up turns blank (a small tilde becomes a space)", { title: "˜" }, ["title"]],
    ["no comm contact (19 imported activities lack one)", { commContactId: null }, ["commContactId"]],
    ["no dates", { startDate: null, endDate: null }, ["startDate", "endDate"]],
    ["no times, not all day", { startTime: null, endTime: null }, ["startTime", "endTime"]],
    ["all day needs no times", { isAllDay: true, startTime: null, endTime: null }, []],
    ["no summary", { details: "" }, ["details"]],
    ["no significance or scheduling", { significance: "", schedule: "" }, ["significance", "schedule"]],
    ["a release category without origin, distribution or comm materials", { categoryId: 58 }, ["nrOriginId", "nrDistributionId", "commMaterialIds"]],
    ["a release category with all three", { categoryId: 12, nrOriginId: 1, nrDistributionId: 1, commMaterialIds: [1] }, []],
    ["ending before it starts (108 imported activities do)", { endDate: "2026-11-09" }, ["endDate"]],
    ["a single day whose start time is after its end time", { startTime: "11:00", endTime: "10:00" }, ["endTime"]],
    ["a single day with equal times", { startTime: "10:00", endTime: "10:00" }, []],
    ["a release date after the end date", { nrDate: "2026-11-11", nrTime: "09:00" }, ["nrDate"]],
    ["a release date without a time", { nrDate: "2026-11-10" }, ["nrTime"]],
    ["a release time without a date", { nrTime: "09:00" }, ["nrDate"]],
    ["times off the 5-minute steps", { startTime: "09:03", endTime: "10:01" }, ["startTime", "endTime"]],
    ["Potential Dates with TBD", { potentialDates: "late june, tbd" }, ["potentialDates"]],
    ["Potential Dates with a digit", { potentialDates: "June 2027" }, ["potentialDates"]],
    ["Potential Dates as a timeline", { potentialDates: "late June" }, []],
    ["a 101-character title", { title: "x".repeat(101) }, ["title"]],
    ["a 56-character venue", { venue: "x".repeat(56) }, ["venue"]],
    ["an 81-character lead organization", { leadOrganization: "x".repeat(81) }, ["leadOrganization"]],
    ["a 51-character Potential Dates", { potentialDates: "x".repeat(51) }, ["potentialDates"]],
    ["31 translations", { translations: Array.from({ length: 31 }, (_, n) => `Language ${"abcdefghijklmnopqrstuvwxyzABCDE"[n]}`) }, ["translations"]],
    ["a translation with a comma", { translations: ["One, two"] }, ["translations"]],
    ["21 HQ tags", { keywordNames: Array.from({ length: 21 }, (_, n) => `Tag ${n}`) }, ["keywordNames"]],
    ["a blank HQ tag", { keywordNames: [" "] }, ["keywordNames"]],
  ])("%s", (_name, over, expected) => expect(fields(over)).toEqual(expected));

  it("HQ isn't required to give Details, Significance or Scheduling; Strategy follows its switch", () => {
    expect(fields({ details: "", significance: "", schedule: "" }, { relaxRequired: true })).toEqual([]);
    expect(fields({}, { rules: { ...ctx.rules, required: { significance: false, scheduling: false, strategy: true } } })).toEqual(["strategy"]);
  });

  it("a limit applies only to a changed value: an imported over-long title saves unchanged, and is refused once edited", () => {
    const long = "x".repeat(150);
    expect(fields({ title: long }, { previous: { ...ok, title: long } })).toEqual([]);
    expect(fields({ title: `${long}y` }, { previous: { ...ok, title: long } })).toEqual(["title"]);
  });

  it("a value whose cleaning expands it is measured on the cleaned form, not the raw one", () => {
    const details = `${"x".repeat(699)}…`; // 700 raw characters; cleanDetails triples the ellipsis to 702
    expect(fields({ details })).toEqual(["details"]);
  });

  it("an unchanged imported title is still refused when its cleaned form would exceed the database's limit", () => {
    const title = "…".repeat(200); // 200 raw characters; cleanTitle triples every ellipsis to 600
    expect(fields({ title }, { previous: { ...ok, title } })).toEqual(["title"]);
  });

  it("Look Ahead fields from someone without the fieldset are refused", () => {
    expect(fields({ lookAhead: { hqComments: "", hqStatus: null, hqSection: "in_the_news", longTermOutlook: false } })).toEqual(["lookAhead"]);
  });

  it("a confidential activity whose section is overridden needs an Executive Summary (Activity.aspx:2419-2421)", () => {
    const lookAhead = { hqComments: "", hqStatus: null, hqSection: "events_and_speeches" as const, longTermOutlook: false };
    expect(fields({ isConfidential: true, lookAhead }, { lookAheadFieldset: true })).toEqual(["lookAhead.hqComments"]);
    expect(fields({ isConfidential: true, lookAhead: { ...lookAhead, hqComments: "Sample summary" } }, { lookAheadFieldset: true })).toEqual([]);
    expect(fields({ isConfidential: true, lookAhead: { ...lookAhead, hqSection: "in_the_news" } }, { lookAheadFieldset: true })).toEqual([]);
  });

  it("dates in the past are a warning, not an error (Activity.aspx:731)", () => {
    expect(warningsFor({ ...ok, startDate: "2026-11-01", endDate: "2026-11-02" }, "2026-11-03")).toEqual(["The start date is in the past.", "The end date is in the past."]);
    expect(warningsFor(ok, "2026-11-03")).toEqual([]);
  });
});
