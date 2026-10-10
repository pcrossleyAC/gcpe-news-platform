import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_LIST_QUERY, type ListPage } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { listApi } from "./api";
import { listCalls, qOf, renderList, row, stubFetch, CONFIG, type Call } from "./fixtures";

/** The server's own refusal (apps/calendar/src/list/query.ts listWhere) of an HQ-only part of a query. */
const refuseHqParts = (url: string) => {
  if (!url.startsWith("/calendar/api/list?") && !url.startsWith("/calendar/api/list/calendar?") && !url.startsWith("/calendar/api/list/export.xlsx")) return undefined;
  const q = qOf(url);
  if (q.corporate) return jsonResponse(403, { error: "Corporate queries are for HQ Advanced users and above" });
  if (q.lookAhead !== "all") return jsonResponse(403, { error: "The Look Ahead filter is for HQ Advanced users and above" });
  return undefined;
};
const hqLink = (view = "") => `/calendar?${view}q=${encodeURIComponent(JSON.stringify({ ...DEFAULT_LIST_QUERY, lookAhead: "look_ahead_only", corporate: { days: 8, statuses: ["new"] } }))}`;

describe("ActivityListScreen (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the first page with the saved display and hides the saved columns", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { preferences: { display: "my_ministries", hiddenColumns: ["keywords", "ministry", "status", "translations"] } });
    renderList();
    expect(await screen.findByRole("heading", { level: 1, name: "Corporate Calendar" })).toBeInTheDocument();
    expect(await screen.findByText("Sample listed")).toBeInTheDocument();
    expect(qOf(listCalls(calls)[0]!.url)).toMatchObject({ display: "my_ministries", sort: "dateTime", dir: "asc", corporate: null });
    expect(screen.queryByRole("columnheader", { name: "HQ Tags" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Title & Summary" })).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 1 activity.")).toBeInTheDocument();
    expect(screen.getByText("HLTH-20001")).toBeInTheDocument();
    // 17:00Z is 10 AM in BC, which stays on UTC-7 from 2026-11-01. The year shows only when it isn't this year's.
    expect(screen.getByText(/^Tue Nov 10( 2026)? 10:00-11:00 AM$/)).toBeInTheDocument();
  });

  it("an unreadable q falls back to the defaults", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList(`/calendar?q=${encodeURIComponent('{"filter":{"colour":"blue"}}')}`);
    await screen.findByText("Sample listed");
    expect(qOf(listCalls(calls)[0]!.url)).toMatchObject({ display: "all", filter: { quickSearch: "" } });
  });

  it("searches with the filter and display chosen, and saves a new display", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    const form = screen.getByRole("form", { name: "Filter activities" });
    await user.type(within(form).getByLabelText("Search for"), "launch");
    await user.selectOptions(within(form).getByLabelText("Category"), "Sample category");
    await user.selectOptions(within(form).getByLabelText("HQ Tags"), ["Sample tag", "Sample other tag"]);
    await user.click(within(form).getByLabelText("My Watchlist Only"));
    await user.click(within(form).getByRole("button", { name: "Search" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(qOf(listCalls(calls)[1]!.url)).toMatchObject({ display: "my_watchlist", corporate: null, filter: { quickSearch: "launch", categoryId: 32, keywordIds: [1, 2] } });
    const put = calls.find((c) => c.url === "/calendar/api/list/preferences" && c.init?.method === "PUT")!;
    expect(JSON.parse(String(put.init!.body))).toEqual({ display: "my_watchlist", hiddenColumns: ["keywords", "ministry", "status", "translations"] });
    // Saving the display never lists the old filter with the new display on the way.
    expect(listCalls(calls)).toHaveLength(2);
  });

  it("refuses a From after the To without asking the server", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    const form = screen.getByRole("form", { name: "Filter activities" });
    await user.type(within(form).getByLabelText("From"), "2026-11-20");
    await user.type(within(form).getByLabelText("To"), "2026-11-10");
    await user.click(within(form).getByRole("button", { name: "Search" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("From must be on or before To.");
    expect(listCalls(calls)).toHaveLength(1);
  });

  it("sorts by a column, then the other way; the sort state is announced", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Title & Summary" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ sort: "title", dir: "asc" }));
    expect(await screen.findByRole("columnheader", { name: "Title & Summary" })).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByRole("button", { name: "Title & Summary" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ sort: "title", dir: "desc" }));
    expect(screen.queryByRole("button", { name: "Premier" })).toBeNull();
  });

  it("loads 30 more at a time without duplicates", async () => {
    const calls: Call[] = [];
    const many = Array.from({ length: 45 }, (_, n) => row({ id: 30000 + n, title: `Sample ${n}` }));
    // The second page starts one row early, as it would after a row moved between the two reads: Sample 29 comes back twice.
    stubFetch(calls, { page: (offset): ListPage => ({ rows: many.slice(offset === 0 ? 0 : offset - 1, offset + 30), total: 45, offset }) });
    renderList();
    await screen.findByText("Sample 0");
    expect(screen.getByText("Showing 30 of 45 activities.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show 15 more" }));
    expect(await screen.findByText("Showing 45 of 45 activities.")).toBeInTheDocument();
    expect(new URL(listCalls(calls).at(-1)!.url, "http://x").searchParams.get("offset")).toBe("30");
    expect(screen.getAllByText("Sample 29")).toHaveLength(1);
    expect(screen.getAllByText(/^Sample \d+$/)).toHaveLength(45);
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("drops a page from an older query that arrives after the query changed", async () => {
    const calls: Call[] = [];
    const many = Array.from({ length: 45 }, (_, n) => row({ id: 30000 + n, title: `Sample ${n}` }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stubFetch(calls, {
      page: async (offset, q): Promise<ListPage> => {
        if (q.sort === "title") return { rows: [row({ id: 40000, title: "Sample by title" })], total: 1, offset: 0 };
        if (offset === 30) await held;
        return { rows: many.slice(offset, offset + 30), total: 45, offset };
      },
    });
    // The held page's own promise: the table's handler was attached to it first, so it has run once this settles.
    const page = vi.spyOn(listApi, "page");
    renderList();
    await screen.findByText("Sample 0");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show 15 more" }));
    await waitFor(() => expect(listCalls(calls).at(-1)!.url).toContain("offset=30"));
    const served = page.mock.results.at(-1)!.value as Promise<ListPage>;
    // The sort changes while the second page of the old query is still on its way.
    await user.click(screen.getByRole("button", { name: "Title & Summary" }));
    expect(await screen.findByText("Sample by title")).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 1 activity.")).toBeInTheDocument();
    await act(async () => {
      release();
      await served;
    });
    await waitFor(() => expect(listCalls(calls)).toHaveLength(3));
    expect(screen.queryByText("Sample 30")).toBeNull();
    expect(screen.getByText("Showing 1 of 1 activity.")).toBeInTheDocument();
  });

  it("hides and shows columns, saving the choice", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByRole("checkbox", { name: "City" }));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "City" })).toBeNull());
    const put = calls.filter((c) => c.url === "/calendar/api/list/preferences" && c.init?.method === "PUT").at(-1)!;
    expect(JSON.parse(String(put.init!.body)).hiddenColumns).toContain("city");
    expect(screen.queryByRole("checkbox", { name: "Activity Id" })).toBeNull();
  });

  it("always shows the freeze window, and an alert while it applies to you", async () => {
    stubFetch([]);
    renderList();
    expect(await screen.findByText(CONFIG.freeze.message)).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([], { config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } });
    renderList();
    expect(await screen.findByText("Change freeze")).toBeInTheDocument();
  });

  it("says so when nothing matches, and when the list can't load", async () => {
    stubFetch([], { page: () => ({ rows: [], total: 0, offset: 0 }) });
    renderList();
    expect(await screen.findByText("No activities match.")).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list?") ? new Response("{}", { status: 503 }) : undefined) });
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load activities.");
  });

  it("a link carrying HQ-only parts still lists for a Health Editor, and Search doesn't resend them", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: refuseHqParts });
    renderList(hqLink());
    expect(await screen.findByText("Sample listed")).toBeInTheDocument();
    expect(qOf(listCalls(calls)[0]!.url)).toMatchObject({ lookAhead: "all", corporate: null });
    const user = userEvent.setup();
    const form = screen.getByRole("form", { name: "Filter activities" });
    await user.type(within(form).getByLabelText("Search for"), "launch");
    await user.click(within(form).getByRole("button", { name: "Search" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(qOf(listCalls(calls)[1]!.url)).toMatchObject({ lookAhead: "all", corporate: null, filter: { quickSearch: "launch" } });
  });

  it("the month view of a link carrying HQ-only parts loads for a Health Editor", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: refuseHqParts, calendar: { items: [{ id: 20001, title: "Sample listed", startAt: "2026-11-10T17:00:00.000Z", endAt: null, isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" }], truncated: false } });
    renderList(hqLink("view=month&on=2026-11-15&"));
    expect(await screen.findByText("HLTH-20001 10:00 AM Sample listed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a 403 on the list or the calendar shows the server's reason", async () => {
    const refuse = (url: string) =>
      url.startsWith("/calendar/api/list?") || url.startsWith("/calendar/api/list/calendar?") ? jsonResponse(403, { error: "Sample refusal from the server" }) : undefined;
    stubFetch([], { other: refuse });
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("Sample refusal from the server");
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([], { other: refuse });
    renderList("/calendar?view=month&on=2026-11-15");
    expect(await screen.findByRole("alert")).toHaveTextContent("Sample refusal from the server");
  });

  it("a filter value that's no longer offered shows as such, and clearing it drops it from the search", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList(`/calendar?q=${encodeURIComponent(JSON.stringify({ ...DEFAULT_LIST_QUERY, filter: { ...DEFAULT_LIST_QUERY.filter, categoryId: 99999, keywordIds: [1, 88888, 77777] } }))}`);
    await screen.findByText("Sample listed");
    const form = screen.getByRole("form", { name: "Filter activities" });
    const category = within(form).getByLabelText<HTMLSelectElement>("Category");
    expect(category.selectedOptions[0]).toHaveTextContent("(no longer available)");
    const tags = within(form).getByLabelText<HTMLSelectElement>("HQ Tags");
    expect([...tags.selectedOptions].map((o) => o.textContent)).toEqual(["Sample tag", "(no longer available)", "(no longer available)"]);
    const user = userEvent.setup();
    await user.selectOptions(category, "Any category");
    await user.deselectOptions(tags, tags.selectedOptions[1]!);
    await user.click(within(form).getByRole("button", { name: "Search" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(qOf(listCalls(calls)[1]!.url)).toMatchObject({ filter: { categoryId: null, keywordIds: [1, 77777] } });
  });

  it("a slower, older settings save doesn't undo a newer one", async () => {
    const calls: Call[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    let puts = 0;
    stubFetch(calls, {
      other: (url, init) => {
        if (url !== "/calendar/api/list/preferences" || init?.method !== "PUT") return undefined;
        const body = JSON.parse(String(init.body)) as object;
        return ++puts === 1 ? first.then(() => jsonResponse(200, body)) : jsonResponse(200, body);
      },
    });
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByRole("checkbox", { name: "City" }));
    await user.click(screen.getByRole("checkbox", { name: "Premier" }));
    await waitFor(() => expect(puts).toBe(2));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "Premier" })).toBeNull());
    await act(async () => {
      releaseFirst();
      await first;
    });
    await waitFor(() => expect(calls.filter((c) => c.url === "/calendar/api/list/preferences")).toHaveLength(3));
    expect(screen.queryByRole("columnheader", { name: "City" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Premier" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Premier" })).not.toBeChecked();
  });

  it("a retried next page clears the earlier failure", async () => {
    const many = Array.from({ length: 45 }, (_, n) => row({ id: 30000 + n, title: `Sample ${n}` }));
    let failures = 1;
    stubFetch([], {
      page: (offset) => ({ rows: many.slice(offset, offset + 30), total: 45, offset }),
      other: (url) => (url.startsWith("/calendar/api/list?") && url.endsWith("&offset=30") && failures-- > 0 ? new Response("{}", { status: 503 }) : undefined),
    });
    renderList();
    await screen.findByText("Sample 0");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show 15 more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load more activities.");
    await user.click(screen.getByRole("button", { name: "Show 15 more" }));
    expect(await screen.findByText("Showing 45 of 45 activities.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load more activities.")).toBeNull();
  });

  it("marks a field that needs review in words, not only colour", async () => {
    stubFetch([], { page: () => ({ rows: [row({ needsReview: ["title"] })], total: 1, offset: 0 }) });
    renderList();
    await screen.findByText("Sample listed");
    expect(screen.getAllByText("(changed, needs review)")).toHaveLength(1);
  });

  it("titles open the activity, carrying this list's address back; New activity shows for creators", async () => {
    stubFetch([]);
    const path = `/calendar?q=${encodeURIComponent(JSON.stringify({ filter: { quickSearch: "Sample" } }))}`;
    renderList(path);
    expect(await screen.findByRole("link", { name: "Sample listed" })).toHaveAttribute("href", `/calendar/activities/20001?return=${encodeURIComponent(path)}`);
    expect(screen.getByRole("link", { name: "New activity" })).toHaveAttribute("href", `/calendar/activities/new?return=${encodeURIComponent(path)}`);
  });

  it("no New activity for a user who can't create", async () => {
    stubFetch([], { config: { ...CONFIG, editor: { ...CONFIG.editor, create: false } } });
    renderList();
    await screen.findByRole("link", { name: "Sample listed" });
    expect(screen.queryByRole("link", { name: "New activity" })).toBeNull();
  });
});
