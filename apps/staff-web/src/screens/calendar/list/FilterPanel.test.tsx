import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { DEFAULT_LIST_QUERY } from "@gcpe/calendar-contract";
import { activeFilterParts } from "./FilterPanel";
import { OPTIONS, renderList, stubFetch } from "./fixtures";

describe("the Filters summary", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("names a running corporate query instead of the filter it replaces", () => {
    const query = { ...DEFAULT_LIST_QUERY, filter: { ...DEFAULT_LIST_QUERY.filter, quickSearch: "launch" }, corporate: { days: 8, statuses: ["new", "la_changed"] as ("new" | "la_changed")[] } };
    expect(activeFilterParts(query, OPTIONS)).toEqual(["Corporate query: next 8 days, New and LA Changed"]);
    expect(activeFilterParts({ ...query, corporate: { days: null, statuses: ["changed"] } }, OPTIONS)).toEqual(["Corporate query: all upcoming, Changed"]);
  });

  it("names the confidential filter, which lives outside the panel (form-order audit #14)", () => {
    expect(activeFilterParts({ ...DEFAULT_LIST_QUERY, lookAhead: "look_ahead_only" }, OPTIONS)).toEqual(["Not confidential only"]);
    expect(activeFilterParts({ ...DEFAULT_LIST_QUERY, lookAhead: "not_for_look_ahead_only" }, OPTIONS)).toEqual(["Confidential only"]);
    expect(activeFilterParts(DEFAULT_LIST_QUERY, OPTIONS)).toEqual([]);
  });

  it("starts closed on a phone even with no filter running, saying No filters", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 40rem)", media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    stubFetch([]);
    renderList();
    await screen.findByText("Sample listed");
    const details = screen.getByRole("form", { name: "Filter activities" }).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details.querySelector("summary")).toHaveTextContent("No filters");
  });
});
