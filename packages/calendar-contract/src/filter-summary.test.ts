import { describe, expect, it } from "vitest";
import { activeFilterParts, filterSummary, filterWarnings, idSearchOf } from "./filter-summary";
import { DEFAULT_LIST_QUERY, type ListOptions, type ListQuery } from "./list";

const OPTIONS: ListOptions = {
  categories: [{ id: 32, name: "Sample category" }], keywords: [], representatives: [], initiatives: [], premierRequested: [], distributions: [],
  ministries: [{ key: "health", abbreviation: "HLTH", name: "Sample Health" }], commContacts: [],
};
const q = (over: Partial<ListQuery> = {}, filter: Partial<ListQuery["filter"]> = {}): ListQuery => ({ ...DEFAULT_LIST_QUERY, ...over, filter: { ...DEFAULT_LIST_QUERY.filter, ...filter } });

/** What the reports and the export say they used (suite review CAL-3): the list's filter, in the Filters summary's words. */
describe("the filter summary the reports and the export state", () => {
  it("says when nothing narrows the list", () => {
    expect(filterSummary(q(), OPTIONS)).toBe("none (every activity you can see)");
    expect(filterWarnings(q())).toEqual([]);
  });

  it("names each part, as the Filters summary does, the Display choice included", () => {
    const query = q({ display: "my_watchlist" }, { from: "2026-11-01", to: "2026-11-14", categoryId: 32, ministryKey: "health" });
    expect(filterSummary(query, OPTIONS)).toBe("Dates: 2026-11-01 to 2026-11-14 · Category: Sample category · Lead Ministry: HLTH · My Watchlist Only");
    expect(filterWarnings(query)).toEqual(["Display is set to My Watchlist Only, which the list keeps from last time, so other activities are left out."]);
  });

  it("an activity number in Search for is the whole filter: the other parts and the dates are ignored, and it says so", () => {
    const query = q({ display: "my_activities" }, { quickSearch: "HLTH-12345", from: "2026-11-01", categoryId: 32 });
    expect(activeFilterParts(query, OPTIONS)).toEqual(["Activity number: HLTH-12345 only"]);
    expect(filterSummary(query, OPTIONS)).toBe("Activity number: HLTH-12345 only");
    expect(filterWarnings(query)).toEqual(["Search for holds an activity number, so only that activity is included: the dates and other filters are ignored."]);
    // A bare number counts above 10,000; a smaller one is a word, such as a year.
    expect(idSearchOf("12345")).toBe(12345);
    expect(idSearchOf("2026")).toBeNull();
  });

  it("the Confidential filter still applies to an activity-number search", () => {
    expect(activeFilterParts(q({ lookAhead: "look_ahead_only" }, { quickSearch: "20001" }), OPTIONS)).toEqual(["Activity number: 20001 only", "Not confidential only"]);
  });

  it("a corporate query replaces the filter, so nothing is warned about the display", () => {
    const query = q({ display: "my_watchlist", corporate: { days: 8, statuses: ["new"] } }, { quickSearch: "HLTH-12345" });
    expect(filterSummary(query, OPTIONS)).toBe("Corporate query: next 8 days, New");
    expect(filterWarnings(query)).toEqual([]);
  });
});
