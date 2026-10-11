import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { friendlyDateRange, type FeedPage } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { ME, stubFetch, type Call } from "../list/fixtures";
import { todayIn } from "../list/dates";
import { answerFeed, feedCalls, feedPage, item, renderUpdates } from "./fixtures";

const TZ = "America/Vancouver";
const entries = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".gcpe-updates > li")];
const reset = () => {
  cleanup();
  vi.unstubAllGlobals();
};

describe("the Updates screen (spec addendum §9.1)", () => {
  afterEach(() => {
    reset();
    vi.useRealTimers();
  });

  it("opens on Today's updates: when, who, what, which activity, its title and dates; the summary on hover; no email", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed(() => jsonResponse(200, feedPage())) });
    const { container } = renderUpdates();
    await screen.findByText("Sample title");
    expect(screen.getByRole("heading", { level: 1, name: "Updates" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Today's updates" })).toBeInTheDocument();
    const [entry] = entries(container);
    expect(entry).toHaveTextContent(
      `Nov 3, 2026 11:00 AM — Robin Staff changed activity HLTH-20001: Sample title (${friendlyDateRange(item(), { timeZone: TZ, today: todayIn(TZ) })})`,
    );
    // The link brings Save and Cancel back to this feed (C149).
    expect(within(entry!).getByRole("link", { name: "HLTH-20001" })).toHaveAttribute("href", "/calendar/activities/20001?return=%2Fcalendar%2Fupdates");
    expect(within(entry!).getByText("Sample title")).toHaveAttribute("title", "Sample summary");
    expect(screen.getByRole("status")).toHaveTextContent("Total 1 item");
    expect(feedCalls(calls)).toEqual(["mode=today"]);
    expect(container.textContent).not.toContain("@");
    expect(document.title).toBe("Updates — GCPE News Staff");
  });

  it("Latest 5 updates and Today's updates are one click away", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed((p) => jsonResponse(200, feedPage({ mode: p.get("mode") as FeedPage["mode"] }))) });
    renderUpdates();
    await screen.findByText("Sample title");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Latest 5 updates" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Latest 5 updates" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Latest 5 updates" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("link", { name: "Today's updates" }));
    await screen.findByRole("heading", { level: 2, name: "Today's updates" });
    await waitFor(() => expect(feedCalls(calls)).toEqual(["mode=today", "mode=latest", "mode=today"]));
  });

  it("searches a date range by kind of update and words, and keeps the search in the address", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed((p) => jsonResponse(200, feedPage({ mode: p.get("mode") as FeedPage["mode"] }))) });
    renderUpdates();
    await screen.findByText("Sample title");
    const type = screen.getByLabelText("Update type") as HTMLSelectElement;
    expect([...type.options].map((o) => o.text)).toEqual(["All", "Changed", "Added", "Deleted", "Reviewed", "Cloned"]);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-11-01");
    await user.type(screen.getByLabelText("To"), "2026-11-03");
    await user.selectOptions(type, "Added");
    await user.type(screen.getByLabelText("Search for"), "  sample ");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("heading", { level: 2, name: 'Activities added from 2026-11-01 to 2026-11-03 matching "sample"' })).toBeInTheDocument();
    await waitFor(() => expect(feedCalls(calls).at(-1)).toBe("mode=range&from=2026-11-01&to=2026-11-03&type=created&keyword=sample"));
  });

  it("From starts at yesterday in BC time, as legacy's did", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T06:30:00Z")); // 23:30 on Nov 2 in BC
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage())) });
    renderUpdates();
    await waitFor(() => expect(screen.getByLabelText("From")).toHaveValue("2026-11-01"));
  });

  it("From after To is caught before any request", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed(() => jsonResponse(200, feedPage())) });
    renderUpdates();
    await screen.findByText("Sample title");
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-11-20");
    await user.type(screen.getByLabelText("To"), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("From must be on or before To.");
    expect(feedCalls(calls)).toEqual(["mode=today"]);
  });

  it("a search naming an activity shows that activity's updates", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ mode: "activity", activityId: 20001 }))) });
    renderUpdates("/calendar/updates?mode=range&keyword=HLTH-20001");
    expect(await screen.findByRole("heading", { level: 2, name: "Updates for HLTH-20001" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search for")).toHaveValue("HLTH-20001");
  });

  it("one activity's updates by address; one the user can't see is not found", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed(() => jsonResponse(404, { error: "not found" })) });
    renderUpdates("/calendar/updates?mode=activity&activity=20001");
    expect(await screen.findByText("Activity not found: it doesn't exist, or you can't see it.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Updates for activity 20001" })).toBeInTheDocument();
    expect(feedCalls(calls)).toEqual(["mode=activity&activity=20001"]);
  });

  it("marks a deleted activity's entries", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ items: [item({ action: "deleted", isDeleted: true })] }))) });
    const { container } = renderUpdates();
    await screen.findByText("Sample title");
    expect(entries(container)[0]).toHaveTextContent("Robin Staff deleted activity HLTH-20001 (deleted): Sample title");
  });

  it("says when nothing matched, when the answer was cut at 1,000, and when it couldn't load", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ items: [] }))) });
    renderUpdates();
    expect(await screen.findByText("No updates.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Total 0 items");
    reset();
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ truncated: true }))) });
    renderUpdates();
    expect(await screen.findByText("Showing the newest 1,000. Narrow the dates or the search to see older updates.")).toBeInTheDocument();
    reset();
    stubFetch([], { other: answerFeed(() => jsonResponse(500, { error: "boom" })) });
    renderUpdates();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the updates.");
  });

  it("a hand-edited address is explained, not sent", async () => {
    const cases: [string, string][] = [
      ["?mode=bogus", "That address isn't one of the updates views."],
      ["?mode=range&from=2026-02-30", "Enter dates as YYYY-MM-DD."],
      ["?mode=range&from=2026-11-05&to=2026-11-01", "From must be on or before To."],
      ["?mode=activity&activity=abc", "That address doesn't name an activity."],
      ["?mode=range&type=transferred", "Choose an update type from the list."],
    ];
    for (const [path, message] of cases) {
      const calls: Call[] = [];
      stubFetch(calls, { other: answerFeed(() => jsonResponse(200, feedPage())) });
      renderUpdates(`/calendar/updates${path}`);
      expect(await screen.findByRole("alert"), path).toHaveTextContent(message);
      expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
      expect(feedCalls(calls), path).toEqual([]);
      reset();
    }
  });

  it("only the view asked for last is shown", async () => {
    const calls: Call[] = [];
    let releaseLatest: (r: Response) => void = () => undefined;
    stubFetch(calls, {
      other: answerFeed((p) =>
        p.get("mode") === "latest"
          ? new Promise<Response>((resolve) => {
              releaseLatest = resolve;
            })
          : jsonResponse(200, feedPage({ items: [item({ title: "Sample today" })] })),
      ),
    });
    renderUpdates("/calendar/updates?mode=latest");
    await waitFor(() => expect(feedCalls(calls)).toEqual(["mode=latest"]));
    await userEvent.setup().click(screen.getByRole("link", { name: "Today's updates" }));
    expect(await screen.findByText("Sample today")).toBeInTheDocument();
    releaseLatest(jsonResponse(200, feedPage({ mode: "latest", items: [item({ title: "Sample stale" })] })));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Sample stale")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Today's updates" })).toBeInTheDocument();
  });

  it("every Calendar user has an Updates tab in the Calendar's tab row", async () => {
    stubFetch([], { me: { ...ME, role: "Calendar.ReadOnly", level: 1 }, other: answerFeed(() => jsonResponse(200, feedPage())) });
    renderUpdates();
    const tabs = await screen.findByRole("navigation", { name: "Calendar sections" });
    expect(within(tabs).getByRole("link", { name: "Updates" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Calendar" })).not.toHaveAttribute("aria-current");
  });
});
