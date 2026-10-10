import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { onUnauthorized } from "../../../api/client";
import { DEFAULT_LIST_QUERY } from "@gcpe/calendar-contract";
import { downloadExport } from "./api";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME, listCalls, qOf, renderList, row, stubFetch, type Call } from "./fixtures";
import { REVIEW_SELECTED_MAX, ReviewSelected } from "./HqTools";

const ROWS = [row({ id: 20001, version: 3 }), row({ id: 20002, version: 5, title: "Sample second" })];
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
    expect(screen.getByRole("button", { name: "Excel export" })).toBeInTheDocument();
    for (const name of [/^Review selected/, "Clear LA Status"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("region", { name: "Corporate Queries" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Look Ahead filter" })).toBeNull();
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
    expect(await screen.findByText("Reviewed 1 activity. 1 skipped because it changed since the list loaded: HLTH-20002.")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/calendar/api/activities/review-selected")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ items: [{ id: 20001, version: 3 }, { id: 20002, version: 5 }] });
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Review selected (0)" })).toBeDisabled();
  });

  it("a 207 partial commit is an alert, not a success", async () => {
    hq([], (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(207, { reviewed: [20001], skipped: [], failed: true }) : url === "/calendar/api/activities/clear-la-status" ? jsonResponse(207, { cleared: 100, failed: true }) : undefined));
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    expect(await screen.findByText("Only 1 of 2 activities were reviewed before a later batch failed. Select the rest and review them again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear LA Status" }));
    expect(await screen.findByText("The LA status of 100 activities was cleared before a later batch failed. Run Clear LA Status again to finish.")).toBeInTheDocument();
  });

  it("a 207 names how many were skipped", async () => {
    hq([], (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(207, { reviewed: [], skipped: [{ id: 20002, reason: "changed" }], failed: true }) : undefined));
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 0 of 2 activities were reviewed before a later batch failed, and 1 was skipped. Select the rest and review them again.");
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

  it("clears the LA status for the days chosen", async () => {
    const calls: Call[] = [];
    hq(calls, (url) => (url === "/calendar/api/activities/clear-la-status" ? jsonResponse(200, { cleared: 3 }) : undefined));
    renderList();
    const user = userEvent.setup();
    const days = await screen.findByLabelText("Days ahead");
    expect(days).toHaveValue(8);
    await user.clear(days);
    await user.type(days, "14");
    await user.click(screen.getByRole("button", { name: "Clear LA Status" }));
    expect(await screen.findByText("Cleared the LA status of 3 activities.")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.url === "/calendar/api/activities/clear-la-status")!.init!.body))).toEqual({ days: 14 });
  });

  it("runs a corporate query and goes back to the filter; sets the Look Ahead filter", async () => {
    const calls: Call[] = [];
    hq(calls);
    renderList();
    const user = userEvent.setup();
    const corp = await screen.findByRole("region", { name: "Corporate Queries" });
    await user.click(within(corp).getByLabelText("Show all"));
    await user.click(within(corp).getByLabelText("Reviewed"));
    await user.click(within(corp).getByRole("button", { name: "Search" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ corporate: { days: null, statuses: ["new", "changed", "reviewed"] } }));
    await user.click(await screen.findByRole("button", { name: "Back to the filter" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ corporate: null }));
    await user.click(within(screen.getByRole("group", { name: "Look Ahead filter" })).getByLabelText("Not for Look Ahead Only"));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ lookAhead: "not_for_look_ahead_only" }));
  });

  it("an export the server refuses shows its reason", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(422, { error: "More than 10,000 activities match: narrow the filter and export again" }) : undefined) });
    renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("More than 10,000 activities match: narrow the filter and export again");
  });

  it("an export turned away while others run says to try again shortly", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(503, { error: "Other exports are running: try again in a few seconds" }) : undefined) });
    renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("try again in a few seconds");
  });

  it("an export whose session has ended sends the user to sign in, as every other call does", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(401, { error: "Sign in again" }) : undefined) });
    const signIn = vi.fn();
    const stop = onUnauthorized(signIn);
    try {
      await expect(downloadExport(DEFAULT_LIST_QUERY)).rejects.toThrow("Sign in again");
    } finally {
      stop();
    }
    expect(signIn).toHaveBeenCalledWith(`${window.location.pathname}${window.location.search}`);
  });

  it("an export downloads the workbook for the current query", async () => {
    const calls: Call[] = [];
    // jsdom has no object URLs.
    const createObjectURL = vi.fn(() => "blob:sample");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    stubFetch(calls, { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? new Response(new Blob(["PK"]), { status: 200 }) : undefined) });
    renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(qOf(calls.find((c) => c.url.startsWith("/calendar/api/list/export.xlsx"))!.url)).toMatchObject({ sort: "dateTime" });
  });
});
