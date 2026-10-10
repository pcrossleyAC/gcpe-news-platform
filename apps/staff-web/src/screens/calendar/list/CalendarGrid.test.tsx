import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { monthRange, shiftMonth, weekRange } from "./dates";
import { renderList, stubFetch, type Call } from "./fixtures";

const ITEM = { id: 20001, title: "Sample listed", startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-12T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" };
const rangeOf = (url: string) => {
  const p = new URL(url, "http://staff.example.test").searchParams;
  return [p.get("start"), p.get("end")];
};

describe("the month and week views (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ranges: whole Sunday-first weeks around the month, or one week", () => {
    expect(monthRange("2026-11-15")).toEqual({ start: "2026-11-01", end: "2026-12-05" });
    expect(monthRange("2026-12-31")).toEqual({ start: "2026-11-29", end: "2027-01-02" });
    expect(weekRange("2026-11-11")).toEqual({ start: "2026-11-08", end: "2026-11-14" });
    expect(shiftMonth("2026-12-15", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01-31", -1)).toBe("2025-12-01");
  });

  it("the month view shows each activity on each of its days, and moves by month", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { calendar: { items: [ITEM], truncated: false } });
    renderList("/calendar?view=month&on=2026-11-15");
    expect(await screen.findByRole("heading", { level: 2, name: "November 2026" })).toBeInTheDocument();
    await waitFor(() => expect(rangeOf(calls.find((c) => c.url.startsWith("/calendar/api/list/calendar?"))!.url)).toEqual(["2026-11-01", "2026-12-05"]));
    for (const day of ["2026-11-10", "2026-11-11", "2026-11-12"]) {
      const cell = document.querySelector(`td[data-date="${day}"]`) as HTMLElement;
      expect(within(cell).getByText(/HLTH-20001/)).toBeInTheDocument();
    }
    expect(within(document.querySelector('td[data-date="2026-11-10"]') as HTMLElement).getByText("HLTH-20001 10:00 AM Sample listed")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByRole("heading", { level: 2, name: "December 2026" })).toBeInTheDocument();
  });

  it("the week view, and the note when the range holds more than 1,000", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { calendar: { items: [ITEM], truncated: true } });
    renderList("/calendar?view=week&on=2026-11-11");
    expect(await screen.findByRole("heading", { level: 2, name: "Week of Nov 8, 2026" })).toBeInTheDocument();
    expect(await screen.findByText("Only the first 1,000 activities are shown. Narrow the filter to see the rest.")).toBeInTheDocument();
    await waitFor(() => expect(rangeOf(calls.find((c) => c.url.startsWith("/calendar/api/list/calendar?"))!.url)).toEqual(["2026-11-08", "2026-11-14"]));
  });

  it("switches between the list and the calendar views", async () => {
    stubFetch([], { calendar: { items: [], truncated: false } });
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByRole("table", { name: /\d{4}$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByText("Sample listed")).toBeInTheDocument();
  });
});
