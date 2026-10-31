import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { onUnauthorized } from "../../../api/client";
import { DEFAULT_LIST_QUERY } from "@gcpe/calendar-contract";
import { downloadExport } from "./api";
import { useEscapeClosesPanels } from "../../../shared/escapeClosesPanels";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME, listCalls, openListTool, qOf, renderList, row, stubFetch, type Call } from "./fixtures";
import { REVIEW_SELECTED_MAX, ReviewSelected } from "./HqTools";

const ROWS = [row({ id: 20001, version: 3 }), row({ id: 20002, version: 5, title: "Sample second" })];
/** Review selected asks first, naming how many (UCFlexiGrid.ascx:4-22; suite review CAL-6). */
const confirmReview = async (user: ReturnType<typeof userEvent.setup>, n: number) =>
  user.click(within(await screen.findByRole("alertdialog", { name: `Review ${n} ${n === 1 ? "activity" : "activities"}?` })).getByRole("button", { name: "Review" }));
const hq = (calls: Call[], other?: (url: string, init?: RequestInit) => Response | undefined) =>
  stubFetch(calls, { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, page: () => ({ rows: ROWS, total: 2, offset: 0 }), other });

describe("the list's HQ tools and the export (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("an Editor gets the export and none of the HQ tools", async () => {
    stubFetch([]);
    renderList();
    await screen.findByText("Sample listed");
    expect(screen.queryByRole("button", { name: "LA status" })).toBeNull();
    await openListTool("Export and reports");
    expect(screen.getByRole("button", { name: "Excel export" })).toBeInTheDocument();
    for (const name of [/^Review selected/, "Clear LA Status"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("region", { name: "Corporate Queries" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Confidential filter" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select HLTH-20001" })).toBeNull();
  });

  it("reviews the ticked rows with their versions, reports skipped rows by MIN-Id and reloads", async () => {
    const calls: Call[] = [];
    hq(calls, (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(200, { reviewed: [20001], skipped: [{ id: 20002, reason: "changed" }] }) : undefined));
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    await confirmReview(user, 2);
    expect(await screen.findByText("Reviewed 1 activity. 1 skipped because it changed since the list loaded: HLTH-20002.")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/calendar/api/activities/review-selected")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ items: [{ id: 20001, version: 3 }, { id: 20002, version: 5 }] });
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Review selected (0)" })).toBeDisabled();
  });

  it("a 207 partial commit is an alert, not a success", async () => {
    hq([], (url) =>
      url === "/calendar/api/activities/review-selected"
        ? jsonResponse(207, { reviewed: [20001], skipped: [], failed: true })
        : url === "/calendar/api/activities/clear-la-status?days=8"
          ? jsonResponse(200, { count: 250 })
          : url === "/calendar/api/activities/clear-la-status"
            ? jsonResponse(207, { cleared: 100, failed: true })
            : undefined,
    );
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    await confirmReview(user, 2);
    expect(await screen.findByText("Only 1 of 2 activities were reviewed before a later batch failed. Select the rest and review them again.")).toBeInTheDocument();
    await openListTool("LA status");
    await user.click(screen.getByRole("button", { name: "Clear LA Status" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear LA Status" }));
    expect(await screen.findByText("The LA status of 100 activities was cleared before a later batch failed. Run Clear LA Status again to finish.")).toBeInTheDocument();
  });

  it("a 207 names how many were skipped", async () => {
    hq([], (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(207, { reviewed: [], skipped: [{ id: 20002, reason: "changed" }], failed: true }) : undefined));
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    await confirmReview(user, 2);
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 0 of 2 activities were reviewed before a later batch failed, and 1 was skipped. Select the rest and review them again.");
  });

  it("asks first, naming how many; Cancel reviews nothing", async () => {
    const calls: Call[] = [];
    hq(calls);
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Review 2 activities?" });
    expect(dialog).toHaveTextContent("Their “Changed: needs review” marks are cleared and they become Reviewed. This can’t be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.url === "/calendar/api/activities/review-selected")).toBe(false);
    expect(screen.getByRole("button", { name: "Review selected (2)" })).toBeEnabled();
  });

  it("is a secondary button, so New activity stays the one primary action", async () => {
    hq([]);
    renderList();
    await screen.findByText("Sample listed");
    expect(screen.getByRole("button", { name: "Review selected (0)" }).className).toMatch(/\bsecondary\b/);
  });

  it("more than 500 selected can't be reviewed at once", () => {
    const selection = (n: number) => new Map(Array.from({ length: n }, (_, i) => [30000 + i, { version: 1, label: `HLTH-${30000 + i}` }] as const));
    render(<ReviewSelected selected={selection(REVIEW_SELECTED_MAX)} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: `Review selected (${REVIEW_SELECTED_MAX})` })).toBeEnabled();
    cleanup();
    render(<ReviewSelected selected={selection(REVIEW_SELECTED_MAX + 1)} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: `Review selected (${REVIEW_SELECTED_MAX + 1})` })).toBeDisabled();
    expect(screen.getByText(`Select at most ${REVIEW_SELECTED_MAX} at a time.`)).toBeInTheDocument();
  });

  it("explains LA status with a ? beside the days field, from the glossary", async () => {
    hq([], () => undefined);
    renderList();
    const user = userEvent.setup();
    await openListTool("LA status");
    await user.click((await screen.findByText("What is LA Status?")).closest("summary")!);
    expect(screen.getByText(/HQ's New or Changed flag on an activity/)).toBeVisible();
  });

  it("Esc closes the LA status panel and focus goes back to its toggle; what was typed in it is still there on reopening", async () => {
    hq([], () => undefined);
    renderList();
    function Esc(): null {
      useEscapeClosesPanels();
      return null;
    }
    render(<Esc />);
    const user = userEvent.setup();
    await openListTool("LA status");
    const days = await screen.findByLabelText("Days ahead (Clear LA Status)");
    await user.clear(days);
    await user.type(days, "14{Escape}");
    const toggle = screen.getByRole("button", { name: "LA status" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    await user.click(toggle);
    expect(screen.getByLabelText("Days ahead (Clear LA Status)")).toHaveValue(14);
  });

  // Owner decision 2026-10-29: it asks first, saying how many activities it will change.
  it("clears the LA status for the days chosen, once confirmed with the count", async () => {
    const calls: Call[] = [];
    hq(calls, (url, init) =>
      url === "/calendar/api/activities/clear-la-status?days=14"
        ? jsonResponse(200, { count: 3 })
        : url === "/calendar/api/activities/clear-la-status" && init?.method === "POST"
          ? jsonResponse(200, { cleared: 3 })
          : undefined,
    );
    renderList();
    const user = userEvent.setup();
    await openListTool("LA status");
    const days = await screen.findByLabelText("Days ahead (Clear LA Status)");
    expect(days).toHaveValue(8);
    await user.clear(days);
    await user.type(days, "14");
    await user.click(screen.getByRole("button", { name: "Clear LA Status" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Clear the LA status of 3 activities?");
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Clear LA Status" }));
    expect(await screen.findByText("Cleared the LA status of 3 activities.")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.url === "/calendar/api/activities/clear-la-status")!.init!.body))).toEqual({ days: 14 });
  });

  it("Cancel on the Clear LA Status confirmation changes nothing", async () => {
    const calls: Call[] = [];
    hq(calls, (url) => (url === "/calendar/api/activities/clear-la-status?days=8" ? jsonResponse(200, { count: 1 }) : undefined));
    renderList();
    const user = userEvent.setup();
    await openListTool("LA status");
    await user.click(await screen.findByRole("button", { name: "Clear LA Status" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Clear the LA status of 1 activity?");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.url === "/calendar/api/activities/clear-la-status")).toBe(false);
  });

  it("Clear LA Status's result stays shown with its panel closed", async () => {
    hq([], (url) => (url === "/calendar/api/activities/clear-la-status?days=8" ? jsonResponse(200, { count: 0 }) : undefined));
    renderList();
    const user = userEvent.setup();
    await openListTool("LA status");
    await user.click(await screen.findByRole("button", { name: "Clear LA Status" }));
    await openListTool("Columns");
    const said = await screen.findByText("No activities up to 8 days ahead have an LA status to clear.");
    expect(said).toHaveAttribute("role", "status");
    expect(said).toBeVisible();
  });

  it("with nothing to clear, says so and asks nothing", async () => {
    const calls: Call[] = [];
    hq(calls, (url) => (url === "/calendar/api/activities/clear-la-status?days=8" ? jsonResponse(200, { count: 0 }) : undefined));
    renderList();
    const user = userEvent.setup();
    await openListTool("LA status");
    await user.click(await screen.findByRole("button", { name: "Clear LA Status" }));
    expect(await screen.findByText("No activities up to 8 days ahead have an LA status to clear.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.some((c) => c.url === "/calendar/api/activities/clear-la-status")).toBe(false);
  });

  it("runs a corporate query and goes back to the filter; sets the Look Ahead filter", async () => {
    const calls: Call[] = [];
    hq(calls);
    renderList();
    const user = userEvent.setup();
    const corp = await screen.findByRole("region", { name: "Corporate Queries" });
    await user.click(within(corp).getByLabelText("Show all"));
    await user.click(within(corp).getByLabelText("Reviewed"));
    // Not running yet: its ticked boxes are only a form, and it says so.
    expect(within(corp).getByText(/^Not applied: the list shows your filters\./)).toBeInTheDocument();
    expect(screen.queryByText("Showing a corporate query.")).toBeNull();
    await user.click(within(corp).getByRole("button", { name: "Run corporate query" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ corporate: { days: null, statuses: ["new", "changed", "reviewed"] } }));
    // Running: a banner above the list, and the closed Saved views names it.
    await screen.findByText("Showing a corporate query.");
    expect(screen.getByText("Showing a corporate query.").closest("[role=status]")).toHaveTextContent("Every ministry's activities: all upcoming, New, Changed and Reviewed.");
    expect(corp.closest("details")!.querySelector("summary")).toHaveTextContent("Running a corporate query");
    expect(within(corp).getByText(/^Running now:/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Back to the filter" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ corporate: null }));
    expect(screen.queryByText("Showing a corporate query.")).toBeNull();
    // The confidential filter (legacy's Look Ahead filter) applies at once, and the Filters summary says so.
    await user.click(within(screen.getByRole("group", { name: "Confidential filter" })).getByLabelText("Confidential only"));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ lookAhead: "not_for_look_ahead_only" }));
    expect(screen.getByRole("form", { name: "Filter activities" }).closest("details")!.querySelector("summary")).toHaveTextContent("Confidential only");
  });

  it("an export the server refuses shows its reason", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(422, { error: "More than 10,000 activities match: narrow the filter and export again" }) : undefined) });
    renderList();
    await openListTool("Export and reports");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("More than 10,000 activities match: narrow the filter and export again");
  });

  it("an export turned away while others run says to try again shortly", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(503, { error: "Other exports are running: try again in a few seconds" }) : undefined) });
    renderList();
    await openListTool("Export and reports");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("try again in a few seconds");
  });

  it("an export whose session has ended sends the user to sign in, as every other call does", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(401, { error: "Sign in again" }) : undefined) });
    const signIn = vi.fn();
    const stop = onUnauthorized(signIn);
    try {
      // Fix round 1 (I1): plain words, not the server's.
      await expect(downloadExport(DEFAULT_LIST_QUERY)).rejects.toThrow("Your session has ended. Sign in again to save — your changes are still here.");
    } finally {
      stop();
    }
    expect(signIn).toHaveBeenCalledWith(`${window.location.pathname}${window.location.search}`, { byUser: true });
  });

  it("an export downloads the workbook for the current query", async () => {
    const calls: Call[] = [];
    // jsdom has no object URLs.
    const createObjectURL = vi.fn(() => "blob:sample");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    stubFetch(calls, { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? new Response(new Blob(["PK"]), { status: 200 }) : undefined) });
    renderList();
    await openListTool("Export and reports");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(qOf(calls.find((c) => c.url.startsWith("/calendar/api/list/export.xlsx"))!.url)).toMatchObject({ sort: "dateTime" });
  });
});
