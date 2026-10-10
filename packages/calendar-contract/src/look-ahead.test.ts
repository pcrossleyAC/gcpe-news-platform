import { describe, expect, it } from "vitest";
import { inferLookAhead, sectionToStore, type LookAheadInput } from "./look-ahead";

const rules = {
  awarenessCategoryIds: [2],
  consultationsMinistryAbbreviation: "CONSULT",
  issueExemptCategoryNames: ["Sample approved event"],
  eventsCategoryNames: ["Sample approved event", "Sample speech"],
  unconfirmedIssueCommMaterialId: 61,
};
const base: LookAheadInput = {
  categoryIds: [32], categoryNames: ["Sample plain category"], contactMinistryAbbreviation: "HLTH",
  isConfidential: false, isIssue: false, isConfirmed: false, commMaterialIds: [],
  startDate: "2026-11-10", endDate: "2026-11-20", currentSection: null,
};
const infer = (over: Partial<LookAheadInput>) => inferLookAhead({ ...base, ...over }, rules);

describe("Look Ahead inference, in legacy's order (Activity.aspx:2466-2521)", () => {
  it("1. Awareness category: fixed, whatever else is set", () => expect(infer({ categoryIds: [2], isIssue: true, isConfirmed: true })).toEqual({ kind: "awareness" }));
  it("2. the consultations ministry: fixed", () => expect(infer({ contactMinistryAbbreviation: "CONSULT", isConfirmed: true })).toEqual({ kind: "consultations" }));
  it("3. confidential: keeps the section it has; a new one is Not on LA", () => {
    expect(infer({ isConfidential: true, isConfirmed: true, currentSection: "in_the_news" })).toEqual({ kind: "section", section: "in_the_news" });
    expect(infer({ isConfidential: true, isConfirmed: true })).toEqual({ kind: "section", section: "not_on_la" });
  });
  it("4. an issue → Issues & Reports, unless an event-like category", () => {
    expect(infer({ isIssue: true })).toEqual({ kind: "section", section: "issues_and_reports" });
    expect(infer({ isIssue: true, isConfirmed: true, categoryNames: ["Sample approved event"] })).toEqual({ kind: "section", section: "events_and_speeches" });
  });
  it("5. unconfirmed with the marker comm material → Issues & Reports", () => {
    expect(infer({ commMaterialIds: [61] })).toEqual({ kind: "section", section: "issues_and_reports" });
    expect(infer({ commMaterialIds: [61], isConfirmed: true })).toEqual({ kind: "section", section: "in_the_news" });
  });
  it("6. confirmed, or ending within 2 days → In the News; event categories → Events & Speeches", () => {
    expect(infer({ isConfirmed: true })).toEqual({ kind: "section", section: "in_the_news" });
    expect(infer({ endDate: "2026-11-11" })).toEqual({ kind: "section", section: "in_the_news" });
    expect(infer({ endDate: "2026-11-12" })).toEqual({ kind: "section", section: "not_on_la" });
    expect(infer({ isConfirmed: true, categoryNames: ["Sample speech"] })).toEqual({ kind: "section", section: "events_and_speeches" });
  });
  it("a start date the browser takes but the calendar can't (a five-digit year) is never 'within 2 days', and doesn't throw", () => {
    expect(infer({ startDate: "275760-09-13", endDate: "275760-09-13" })).toEqual({ kind: "section", section: "not_on_la" });
  });
  it("otherwise Not on LA; with no dates, never 'within 2 days'", () => {
    expect(infer({})).toEqual({ kind: "section", section: "not_on_la" });
    expect(infer({ startDate: null, endDate: null })).toEqual({ kind: "section", section: "not_on_la" });
  });
});

describe("the section the server stores (spec addendum §7.6)", () => {
  const stored = (over: Partial<LookAheadInput>): LookAheadInput => ({ ...base, ...over });
  it("a Look Ahead fieldset user's choice wins", () => {
    expect(sectionToStore({ before: null, after: base, chosen: "events_and_speeches" }, rules)).toBe("events_and_speeches");
  });
  it("on create, the inference", () => {
    expect(sectionToStore({ before: null, after: { ...base, isConfirmed: true }, chosen: undefined }, rules)).toBe("in_the_news");
  });
  it("on update, the new inference when the stored section was inferred", () => {
    const before = stored({ isConfirmed: true, currentSection: "in_the_news" });
    expect(sectionToStore({ before, after: { ...before, isIssue: true }, chosen: undefined }, rules)).toBe("issues_and_reports");
  });
  it("an HQ override (a stored section the stored fields don't infer) stays through a ministry user's save", () => {
    const before = stored({ isConfirmed: true, currentSection: "events_and_speeches" });
    expect(sectionToStore({ before, after: { ...before, isIssue: true }, chosen: undefined }, rules)).toBe("events_and_speeches");
  });
  it("awareness and consultations keep the stored section; a new one stores Not on LA", () => {
    expect(sectionToStore({ before: null, after: { ...base, categoryIds: [2] }, chosen: undefined }, rules)).toBe("not_on_la");
    const before = stored({ categoryIds: [2], currentSection: "in_the_news" });
    expect(sectionToStore({ before, after: before, chosen: undefined }, rules)).toBe("in_the_news");
  });
  it("awareness and consultations take no override: a fieldset user's choice is ignored (Activity.aspx:2470-2481)", () => {
    expect(sectionToStore({ before: null, after: { ...base, categoryIds: [2] }, chosen: "in_the_news" }, rules)).toBe("not_on_la");
    expect(sectionToStore({ before: null, after: { ...base, contactMinistryAbbreviation: "CONSULT" }, chosen: "events_and_speeches" }, rules)).toBe("not_on_la");
    const aware = stored({ categoryIds: [2], currentSection: "in_the_news" });
    expect(sectionToStore({ before: aware, after: aware, chosen: "issues_and_reports" }, rules)).toBe("in_the_news");
    const consult = stored({ contactMinistryAbbreviation: "CONSULT", currentSection: "events_and_speeches" });
    expect(sectionToStore({ before: consult, after: consult, chosen: "in_the_news" }, rules)).toBe("events_and_speeches");
  });
});
