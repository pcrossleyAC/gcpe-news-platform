import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import type { ActivityLookup } from "@gcpe/nrms-contract";
import { ActivityLookupPanel, useActivityLookup } from "./ActivityLookupPanel";

const FOUND: ActivityLookup = {
  id: 4102, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z",
  ministryName: "Health", location: "Victoria", translations: ["French", "Punjabi"], notEligible: null,
  prefill: { publishAt: "2031-06-11T17:00:00.000Z", location: "Victoria", ministries: ["health"], leadMinistryKey: "health", sectors: [], themes: [], tags: [] },
};

function renderPanel(lookup: ActivityLookup | null, storedId: number | null = null, error = false) {
  return render(
    <MemoryRouter>
      <ActivityLookupPanel lookup={lookup} error={error} storedId={storedId} timeZone="America/Vancouver" />
    </MemoryRouter>,
  );
}

describe("ActivityLookupPanel (spec addendum §11)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a found activity: its title links to it, with its ministry, start and the translations it requires", () => {
    renderPanel(FOUND);
    const status = screen.getByRole("status");
    expect(screen.getByRole("link", { name: "Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(status).toHaveTextContent("Sample clinic opening · Health · Jun 11, 2031 10:00 AM");
    expect(status).toHaveTextContent("Translations required: French, Punjabi");
  });

  it("says why nothing is filled in", () => {
    renderPanel({ ...FOUND, prefill: null, notEligible: "Nothing is filled in: it has ended." });
    expect(screen.getByRole("status")).toHaveTextContent("Nothing is filled in: it has ended.");
  });

  it("names every other state, and a stored id that wasn't migrated (C158)", () => {
    const text = (lookup: ActivityLookup, stored: number | null = null) => {
      renderPanel(lookup, stored);
      const t = screen.getByRole("status").textContent;
      cleanup();
      return t;
    };
    expect(text({ id: 9999, state: "unknown" })).toBe("No Calendar activity has ID 9999.");
    expect(text({ id: 777000, state: "unknown" }, 777000)).toBe("Legacy activity 777000, not migrated");
    expect(text({ id: 5003, state: "deleted" })).toBe("Calendar activity 5003 has been deleted.");
    expect(text({ id: 5002, state: "hidden" })).toBe("Calendar activity 5002: its details aren’t shown to you.");
  });

  it("shows nothing before a lookup", () => {
    renderPanel(null);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("useActivityLookup asks NRMS for a valid id only, and reads a 404 as unknown", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return url.endsWith("/4102") ? new Response(JSON.stringify(FOUND), { status: 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }));
    const { result, rerender } = renderHook(({ id }) => useActivityLookup(id), { initialProps: { id: 4102 as number | null } });
    await waitFor(() => expect(result.current).toEqual({ lookup: FOUND, error: false }));
    rerender({ id: 2_147_483_648 });
    expect(result.current).toEqual({ lookup: null, error: false });
    rerender({ id: 12 });
    await waitFor(() => expect(result.current).toEqual({ lookup: { id: 12, state: "unknown" }, error: false }));
    expect(calls).toEqual(["/nrms/api/calendar-activities/4102", "/nrms/api/calendar-activities/12"]);
  });

  it("a non-404 failure (500) sets error, not a 404-shaped lookup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })));
    const { result } = renderHook(({ id }) => useActivityLookup(id), { initialProps: { id: 4102 as number | null } });
    await waitFor(() => expect(result.current).toEqual({ lookup: null, error: true }));
  });

  it("the panel shows a short generic alert on error, never the error detail", () => {
    renderPanel(null, null, true);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t look up that activity — try again.");
  });

  it("has no serious or critical axe violations in any state", async () => {
    for (const lookup of [FOUND, { ...FOUND, prefill: null, notEligible: "Nothing is filled in: it has ended." }, { id: 9999, state: "unknown" }, { id: 5003, state: "deleted" }, { id: 5002, state: "hidden" }] as ActivityLookup[]) {
      const { container } = renderPanel(lookup);
      const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
      cleanup();
    }
    const { container } = renderPanel(null, null, true);
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
