import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { jsonResponse } from "../../../../test/jsonResponse";
import { CONFIG, HQ_ADMIN_CONFIG, HQ_ADMIN_ME, never, renderList, row, stubFetch } from "./fixtures";
import { REVIEW_SELECTED_MAX, ReviewSelected } from "./HqTools";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the activity list in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("rows, with review markup", async () => {
    stubFetch([], { page: () => ({ rows: [row({ needsReview: ["title"], isShared: true, hasRelease: true, keywords: ["Sample tag"] })], total: 1, offset: 0 }) });
    const { container } = renderList();
    await screen.findByText("Sample listed");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("no rows, and the freeze in force", async () => {
    stubFetch([], { page: () => ({ rows: [], total: 0, offset: 0 }), config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } });
    const { container } = renderList();
    await screen.findByText("No activities match.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the list failing to load", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list?") ? new Response("{}", { status: 503 }) : undefined) });
    const { container } = renderList();
    await screen.findByText("Couldn't load activities.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the column chooser open, and a filter error shown", async () => {
    stubFetch([]);
    const { container } = renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.type(screen.getByLabelText("From"), "2026-11-20");
    await user.type(screen.getByLabelText("To"), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("From must be on or before To.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("My Queries with one being renamed, and a watched row", async () => {
    stubFetch([], {
      saved: [{ id: 7, name: "Sample one", sortOrder: 1, filter: null }],
      page: () => ({ rows: [row({ isWatched: true, watcherNames: ["Robin Staff"] })], total: 1, offset: 0 }),
    });
    const { container } = renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Rename Sample one" }));
    await screen.findByLabelText("New name");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("an HQ Administrator's tools, after a partial review", async () => {
    stubFetch([], {
      me: HQ_ADMIN_ME,
      config: HQ_ADMIN_CONFIG,
      other: (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(207, { reviewed: [], skipped: [{ id: 20001, reason: "changed" }], failed: true }) : undefined),
    });
    const { container } = renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("button", { name: "Review selected (1)" }));
    await screen.findByText(/before a later batch failed/);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the month view and the week view", async () => {
    const item = { id: 20001, title: "Sample listed", startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" };
    stubFetch([], { calendar: { items: [item], truncated: true } });
    const month = renderList("/calendar?view=month&on=2026-11-15");
    await screen.findByText("HLTH-20001 10:00 AM Sample listed");
    expect(await seriousViolations(month.container)).toEqual([]);
    cleanup();
    const week = renderList("/calendar?view=week&on=2026-11-11");
    await screen.findByText("HLTH-20001 10:00 AM Sample listed");
    expect(await seriousViolations(week.container)).toEqual([]);
  });

  it("loading: the screen, the table and the grid", async () => {
    stubFetch([], { other: (url) => (url === "/calendar/api/config" ? never() : undefined) });
    const screenLoading = renderList();
    expect(await screen.findByRole("heading", { level: 1, name: "Corporate Calendar" })).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await seriousViolations(screenLoading.container)).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([], { page: never });
    const table = renderList();
    expect(await screen.findByText("Loading activities…")).toBeInTheDocument();
    expect(await seriousViolations(table.container)).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/calendar?") ? never() : undefined) });
    const grid = renderList("/calendar?view=month&on=2026-11-15");
    const region = await screen.findByRole("region", { name: "November 2026" });
    expect(within(region).getByText("Loading…")).toBeInTheDocument();
    expect(await seriousViolations(grid.container)).toEqual([]);
  });

  it("the screen failing to load", async () => {
    stubFetch([], { other: (url) => (url === "/calendar/api/config" ? new Response("{}", { status: 503 }) : undefined) });
    const { container } = renderList();
    await screen.findByText("Couldn't load the Calendar list.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the next page failing to load, with Show more still offered", async () => {
    const many = Array.from({ length: 45 }, (_, n) => row({ id: 30000 + n, title: `Sample ${n}` }));
    stubFetch([], {
      page: (offset) => ({ rows: many.slice(offset, offset + 30), total: 45, offset }),
      other: (url) => (url.startsWith("/calendar/api/list?") && url.endsWith("&offset=30") ? new Response("{}", { status: 503 }) : undefined),
    });
    const { container } = renderList();
    await screen.findByText("Sample 0");
    await userEvent.setup().click(screen.getByRole("button", { name: "Show 15 more" }));
    await screen.findByText("Couldn't load more activities.");
    expect(screen.getByRole("button", { name: "Show 15 more" })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("My Queries failing to load", async () => {
    stubFetch([], { other: (url, init) => (url === "/calendar/api/saved-filters" && (init?.method ?? "GET") === "GET" ? new Response("{}", { status: 503 }) : undefined) });
    const { container } = renderList();
    await screen.findByText("Couldn't load your queries.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("My Queries after a save, and after a stale reorder", async () => {
    stubFetch([], {
      saved: [{ id: 7, name: "Sample one", sortOrder: 1, filter: null }, { id: 8, name: "Sample two", sortOrder: 2, filter: null }],
      other: (url, init) =>
        url === "/calendar/api/saved-filters" && init?.method === "POST"
          ? jsonResponse(201, { id: 9, name: "Sample new", sortOrder: 3, filter: null })
          : url === "/calendar/api/saved-filters/order"
            ? jsonResponse(409, { code: "stale", error: "Your queries changed since you loaded them: reload and try again" })
            : undefined,
    });
    const { container } = renderList();
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "My Queries" });
    await user.type(within(region).getByLabelText("Name for this filter"), "Sample new");
    await user.click(within(region).getByRole("button", { name: "Save query" }));
    await screen.findByText("Saved the query “Sample new”.");
    expect(await seriousViolations(container)).toEqual([]);
    await user.click(within(region).getByRole("button", { name: "Move Sample two up" }));
    await screen.findByText("Your queries changed in another tab, so they were reloaded.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the watch star failing", async () => {
    stubFetch([], { other: (url) => (url === "/calendar/api/activities/20001/watch" ? new Response("{}", { status: 503 }) : undefined) });
    const { container } = renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Watch HLTH-20001" }));
    await screen.findByText("Couldn't change your watchlist.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("Clear LA Status: its result, then days it can't take", async () => {
    stubFetch([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, other: (url) => (url === "/calendar/api/activities/clear-la-status" ? jsonResponse(200, { cleared: 3 }) : undefined) });
    const { container } = renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Clear LA Status" }));
    await screen.findByText("Cleared the LA status of 3 activities.");
    expect(await seriousViolations(container)).toEqual([]);
    const days = screen.getByLabelText("Days ahead");
    await user.clear(days);
    await user.type(days, "999");
    expect(days).toHaveAttribute("aria-invalid", "true");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the hint for more than 500 selected", async () => {
    const selected = new Map(Array.from({ length: REVIEW_SELECTED_MAX + 1 }, (_, n) => [30000 + n, { version: 1, label: `HLTH-${30000 + n}` }] as const));
    const { container } = render(<ReviewSelected selected={selected} onDone={() => {}} />);
    expect(screen.getByText(`Select at most ${REVIEW_SELECTED_MAX} at a time.`)).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the export failing", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(503, { error: "Other exports are running: try again in a few seconds" }) : undefined) });
    const { container } = renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    await screen.findByText("Other exports are running: try again in a few seconds");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the grid failing to load", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/calendar?") ? new Response("{}", { status: 503 }) : undefined) });
    const { container } = renderList("/calendar?view=month&on=2026-11-15");
    await screen.findByText("Couldn't load the calendar.");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
