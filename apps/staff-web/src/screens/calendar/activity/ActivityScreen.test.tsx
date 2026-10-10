import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { CONFIG, HQ_ADMIN_CONFIG, HQ_ADMIN_ME, ME } from "../list/fixtures";
import { FIELDS, renderActivity, stubActivity, view, type Call } from "./fixtures";
import { IDLE_MS, POLL_MS } from "./useEditLock";

const ACTIVITY = "/calendar/api/activities/20001";
const isPut = (c: Call) => c.init?.method === "PUT" && c.url === ACTIVITY;
const putBody = (calls: Call[]) => JSON.parse(String(calls.find(isPut)!.init!.body)) as Record<string, unknown>;
const savedOk = (url: string, init?: RequestInit) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(200, { id: 20001, activity: view({ version: 4 }), warnings: [] }) : undefined);
const title = () => screen.findByRole("textbox", { name: "Title" });
const LOCKED = { code: "locked", error: "Sample Admin is editing this activity (since 11:00)", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } };
const NOT_EDITABLE = { edit: false, clone: false, delete: false, review: false };

describe("the activity editor (spec addendum §8.2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens an activity with legacy's fieldsets, in legacy's order, holding the stored values", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20001" })).toBeInTheDocument();
    expect([...container.querySelectorAll(".gcpe-fieldset > legend")].map((l) => l.textContent)).toEqual(["Overview", "Planning", "Ministry", "Schedule", "Release", "Event"]);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample activity");
    expect(screen.getByRole("combobox", { name: "Comm Contact" })).toHaveValue("11");
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveValue("09:00");
    expect(screen.getByRole("textbox", { name: "Potential Dates" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Other City" })).toBeNull();
  });

  it("Save sends the fields with the change, the version and this tab's id, and no Look Ahead fields, then goes back where the user came from (C149)", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { other: savedOk });
    const back = "/calendar?q=%7B%22filter%22%3A%7B%7D%7D";
    const { router } = renderActivity(`/calendar/activities/20001?return=${encodeURIComponent(back)}`);
    const t = await title();
    await userEvent.clear(t);
    await userEvent.type(t, "Sample renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sample list" })).toBeInTheDocument();
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(back);
    expect(screen.getByText("Saved HLTH-20001.")).toBeInTheDocument();
    const body = putBody(calls);
    expect(body).toMatchObject({ ...FIELDS, title: "Sample renamed", version: 3 });
    expect(typeof body.tabId).toBe("string");
    expect(body).not.toHaveProperty("lookAhead");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(calls.filter((c) => c.url.endsWith("/lock") && c.init?.method === "PUT")).toHaveLength(1);
  });

  it("the form's own check stops a save and lists each problem, linked to its field", async () => {
    const calls: Call[] = [];
    stubActivity(calls);
    renderActivity("/calendar/activities/20001");
    const t = await title();
    await userEvent.clear(t);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Fix these to save");
    expect(within(summary).getByRole("link", { name: "Enter a title" })).toHaveAttribute("href", "#activity-title");
    await waitFor(() => expect(summary).toHaveFocus());
    expect(t).toHaveAttribute("aria-invalid", "true");
    expect(t).toHaveAccessibleDescription(/Enter a title/);
    expect(calls.some(isPut)).toBe(false);
  });

  it("the server's 422 shows against its field and keeps the changes", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT" ? jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "commContactId", message: "That comm contact is no longer active" }] }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    const venue = await screen.findByRole("textbox", { name: "Venue" });
    await userEvent.type(venue, "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("link", { name: "That comm contact is no longer active" })).toHaveAttribute("href", "#activity-commContactId");
    expect(screen.getByRole("combobox", { name: "Comm Contact" })).toHaveAttribute("aria-invalid", "true");
    expect(venue).toHaveValue("Sample hall");
  });

  it("a 409 keeps the changes, says someone else changed it, and Reload shows theirs", async () => {
    let current = view();
    stubActivity([], {
      view: () => current,
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT" ? jsonResponse(409, { code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Someone else changed this activity — reload to see their changes")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
    current = view({ version: 5, fields: { ...FIELDS, title: "Sample theirs" } });
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample theirs"));
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("");
  });

  it("a 423 on save keeps the changes and names who holds the lock", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT"
          ? jsonResponse(423, { code: "locked", error: "Sample Admin is editing this activity (since 11:00)", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } })
          : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Sample Admin is editing this activity (since 11:00 AM)", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
    expect(screen.getAllByText(/Sample Admin is editing this activity/)).toHaveLength(1);
  });

  it("Save after the lock lapsed takes it again first; when someone else has it, nothing is sent and the changes stay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls: Call[] = [];
      let lockTaken = false;
      stubActivity(calls, {
        other: (url, init) => {
          if (!url.endsWith("/lock") || init?.method !== "PUT" || !lockTaken) return undefined;
          return jsonResponse(423, { code: "locked", error: "Sample Admin is editing this activity (since 11:00)", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } });
        },
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderActivity("/calendar/activities/20001");
      const venue = await screen.findByRole("textbox", { name: "Venue" });
      await user.type(venue, "Sample hall");
      await act(async () => void (await vi.advanceTimersByTimeAsync(IDLE_MS)));
      expect(screen.getByText("Your edit lock lapsed.", { exact: false })).toBeInTheDocument();
      lockTaken = true;
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Sample Admin is editing this activity (since 11:00 AM)", { exact: false })).toBeInTheDocument();
      expect(calls.some(isPut)).toBe(false);
      expect(venue).toHaveValue("Sample hall");
      expect(venue).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a save to an activity that is no longer there stops editing and keeps the changes on screen", async () => {
    stubActivity([], { other: (url, init) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(404, { error: "not found" }) : undefined) });
    renderActivity("/calendar/activities/20001");
    const venue = await screen.findByRole("textbox", { name: "Venue" });
    await userEvent.type(venue, "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This activity is no longer available.")).toBeInTheDocument();
    expect(venue).toHaveValue("Sample hall");
    expect(venue).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a network failure keeps the changes and says so", async () => {
    stubActivity([], {
      other: (url, init) => {
        if (url === ACTIVITY && init?.method === "PUT") throw new TypeError("Failed to fetch");
        return undefined;
      },
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save. Your changes are still here; try again.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each([
    ["a Read Only user", { me: { ...ME, role: "Calendar.ReadOnly", level: 1 }, view: view({ can: NOT_EDITABLE }) }, "You can view this activity but not change it."],
    ["a shared ministry", { me: { ...ME, ministryKeys: ["finance"] }, view: view({ can: NOT_EDITABLE, fields: { ...FIELDS, sharedWithKeys: ["finance"] } }) }, "Your ministry is shared on this activity: you can view it but not change it."],
    ["the freeze", { config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } }, "You cannot make content changes between 4pm-5pm."],
    ["a deleted activity", { view: view({ isDeleted: true, can: NOT_EDITABLE }) }, "This activity is deleted."],
    ["someone else's lock", { view: view({ lock: { holderName: "Sample Admin", since: "2026-11-03T18:00:00.000Z", mine: false, tabId: null } }) }, "Sample Admin is editing this activity (since 11:00 AM)."],
  ])("%s sees the form read-only, saying why", async (_who, stub, why) => {
    stubActivity([], stub);
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByText(why, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a first change that can't take the lock is undone, and the page says who holds it", async () => {
    stubActivity([], {
      other: (url, init) =>
        url.endsWith("/lock") && init?.method === "PUT"
          ? jsonResponse(423, { code: "locked", error: "Sample Admin is editing this activity (since 11:00)", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } })
          : undefined,
    });
    renderActivity("/calendar/activities/20001");
    const venue = await screen.findByRole("textbox", { name: "Venue" });
    await userEvent.type(venue, "X");
    expect(await screen.findByText("Sample Admin is editing this activity", { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(venue).toHaveValue(""));
    expect(venue).toBeDisabled();
  });

  it("HQ sees the Look Ahead fieldset; the section follows the inference until chosen, and the choice is sent (spec addendum §7.6)", async () => {
    const calls: Call[] = [];
    const la = { hqComments: "", hqStatus: null, hqSection: "in_the_news" as const, longTermOutlook: false };
    stubActivity(calls, {
      me: HQ_ADMIN_ME,
      config: HQ_ADMIN_CONFIG,
      view: view({ fields: { ...FIELDS, lookAhead: la }, lookAhead: { ...la, inferred: { kind: "section", section: "in_the_news" } } }),
      other: savedOk,
    });
    renderActivity("/calendar/activities/20001");
    const section = await screen.findByRole("combobox", { name: "LA Section" });
    expect(section).toHaveValue("in_the_news");
    await userEvent.click(screen.getByRole("checkbox", { name: "Issue" }));
    expect(section).toHaveValue("issues_and_reports");
    await userEvent.selectOptions(section, "not_on_la");
    expect(section).toHaveAccessibleDescription("Override (inferred: Issues & Reports)");
    await userEvent.click(screen.getByRole("checkbox", { name: "Dates Confirmed" }));
    expect(section).toHaveValue("not_on_la");
    await userEvent.click(screen.getByRole("button", { name: "Use the inferred section" }));
    expect(section).toHaveValue("issues_and_reports");
    await userEvent.selectOptions(section, "events_and_speeches");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Sample list" });
    expect(putBody(calls).lookAhead).toEqual({ ...la, hqSection: "events_and_speeches" });
  });

  it("needs-review markup is in each flagged field's description, for HQ (Activity.aspx.cs:1071-1074)", async () => {
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ needsReview: ["title", "start_date"] }) });
    renderActivity("/calendar/activities/20001");
    expect(await title()).toHaveAccessibleDescription(/Changed: needs review/);
    expect(screen.getByRole("textbox", { name: "Potential Dates" })).toHaveAccessibleDescription(/Changed: needs review/);
    expect(screen.getByRole("textbox", { name: "Summary" })).not.toHaveAccessibleDescription(/needs review/);
  });

  it("a category that hides the Release fieldset hides it and sends no release time", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { view: view({ fields: { ...FIELDS, nrDate: "2031-11-10", nrTime: "08:00" } }), other: savedOk });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("group", { name: "Release" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "2");
    expect(screen.queryByRole("group", { name: "Release" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Sample list" });
    expect(putBody(calls)).toMatchObject({ categoryId: 2, nrDate: null, nrTime: null });
  });

  it("Other City shows only with the city 'Other…'", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "City" }), "311");
    expect(screen.getByRole("textbox", { name: "Other City" })).toBeInTheDocument();
  });

  it("a past start date is a warning, not a stop", async () => {
    stubActivity([], { view: view({ fields: { ...FIELDS, startDate: "2020-01-06", endDate: "2020-01-06" } }) });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByText("The start date is in the past.")).toBeInTheDocument();
  });

  it("a new activity starts at 8:00 AM to 6:00 PM in the user's only ministry; saving opens it (Activity.aspx.cs:1066)", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      view: () => view({ id: 20002 }),
      other: (url, init) => (url === "/calendar/api/activities" && init?.method === "POST" ? jsonResponse(201, { id: 20002, activity: view({ id: 20002 }), warnings: [] }) : undefined),
    });
    const { router } = renderActivity(`/calendar/activities/new?return=${encodeURIComponent("/calendar")}`);
    expect(await screen.findByRole("heading", { level: 1, name: "New activity" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveValue("08:00");
    expect(screen.getByRole("combobox", { name: "End time" })).toHaveValue("18:00");
    expect(screen.getByRole("combobox", { name: "Lead Ministry" })).toHaveValue("health");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "32");
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Sample new");
    await userEvent.type(screen.getByRole("textbox", { name: "Summary" }), "Sample summary");
    await userEvent.type(screen.getByRole("textbox", { name: "Significance" }), "Sample significance");
    await userEvent.type(screen.getByRole("textbox", { name: "Scheduling considerations" }), "Sample scheduling");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Comm Contact" }), "11");
    fireEvent.change(screen.getByLabelText(/^Start date/), { target: { value: "2031-11-10" } });
    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: "2031-11-10" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20002" })).toBeInTheDocument();
    expect(screen.getByText("Created HLTH-20002.")).toBeInTheDocument();
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/calendar/activities/20002?return=%2Fcalendar");
    const post = JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));
    expect(post).toMatchObject({ title: "Sample new", startDate: "2031-11-10", startTime: "08:00", endTime: "18:00", contactMinistryKey: "health", commContactId: 11 });
    expect(calls.filter((c) => c.url.endsWith("/lock"))).toHaveLength(0);
  });

  it("a save the writer can't see goes back with the server's message", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT" ? jsonResponse(200, { id: 20001, activity: null, warnings: ["Saved. You can't view confidential activities for this ministry."] }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Not for Look Ahead" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. You can't view confidential activities for this ministry.")).toBeInTheDocument();
  });

  it.each([
    ["a malformed id", "/calendar/activities/abc", undefined],
    ["an id the user can't see", "/calendar/activities/20001", jsonResponse(404, { error: "not found" })],
  ])("%s is 'Activity not found'", async (_what, path, answer) => {
    const calls: Call[] = [];
    stubActivity(calls, answer ? { view: () => answer } : {});
    renderActivity(path);
    expect(await screen.findByRole("heading", { level: 1, name: "Activity not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the Calendar" })).toHaveAttribute("href", "/calendar");
    if (!answer) expect(calls.some((c) => c.url.startsWith("/calendar/api/activities/"))).toBe(false);
  });

  it("leaving with unsaved changes asks first; Stay keeps them, Leave goes", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sample list" })).toBeInTheDocument();
  });

  it("a dirty editor let back in by the poll keeps its own version, so Save meets the other user's change as a 409 (spec addendum §7.5)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls: Call[] = [];
      let current = view();
      stubActivity(calls, {
        view: () => current,
        other: (url, init) => {
          if (url !== ACTIVITY || init?.method !== "PUT") return undefined;
          if (calls.filter(isPut).length === 1) return jsonResponse(423, LOCKED);
          const sent = JSON.parse(String(init.body)) as { version: number };
          return sent.version === current.version
            ? jsonResponse(200, { id: 20001, activity: view({ version: current.version + 1 }), warnings: [] })
            : jsonResponse(409, { code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" });
        },
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderActivity("/calendar/activities/20001");
      await user.type(await screen.findByRole("textbox", { name: "Venue" }), "Mine");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Sample Admin is editing this activity", { exact: false });
      current = view({ version: 5, fields: { ...FIELDS, title: "Sample theirs" } });
      await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS + 1_000)));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument());
      expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Mine");
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Someone else changed this activity — reload to see their changes")).toBeInTheDocument();
      expect(JSON.parse(String(calls.filter(isPut)[1]!.init!.body))).toMatchObject({ version: 3, title: "Sample activity", venue: "Mine" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the date inputs stop at the years the server takes", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    const start = await screen.findByLabelText(/^Start date/);
    expect(start).toHaveAttribute("min", "1900-01-01");
    expect(start).toHaveAttribute("max", "2199-12-31");
  });

  it.each(["0026-11-10", "20255-01-01", "2200-01-01"])("a start date of %s is refused before sending", async (d) => {
    const calls: Call[] = [];
    stubActivity(calls);
    renderActivity("/calendar/activities/20001");
    fireEvent.change(await screen.findByLabelText(/^Start date/), { target: { value: d } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Enter a year between 1900 and 2199" })).toHaveAttribute("href", "#activity-startDate");
    expect(calls.some(isPut)).toBe(false);
  });

  it("a server 400's issues show against their fields", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT" ? jsonResponse(400, { error: "invalid request", issues: [{ path: ["startDate"], code: "custom", message: "not a real date between 1900 and 2199" }] }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "not a real date between 1900 and 2199" })).toHaveAttribute("href", "#activity-startDate");
    expect(screen.getByLabelText(/^Start date/)).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(summary).toHaveFocus());
  });

  it("an error on a field the form doesn't show is named without a link", async () => {
    stubActivity([], {
      view: view({ fields: { ...FIELDS, categoryId: 2 } }),
      other: (url, init) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "nrOriginId", message: "That origin is no longer in use" }] }) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByText("That origin is no longer in use")).toBeInTheDocument();
    expect(within(summary).queryByRole("link")).toBeNull();
  });

  it("a save refused by the freeze says so once", async () => {
    stubActivity([], { other: (url, init) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(423, { code: "freeze", error: CONFIG.freeze.message }) : undefined) });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(CONFIG.freeze.message);
    expect(screen.getAllByText(CONFIG.freeze.message)).toHaveLength(1);
  });

  it("a save answered 'deleted' stops editing and keeps the changes on screen", async () => {
    stubActivity([], { other: (url, init) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(409, { code: "deleted", error: "This activity is deleted" }) : undefined) });
    renderActivity("/calendar/activities/20001");
    const venue = await screen.findByRole("textbox", { name: "Venue" });
    await userEvent.type(venue, "x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This activity is deleted")).toBeInTheDocument();
    expect(venue).toHaveValue("x");
    expect(venue).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a stored time off the 5-minute steps is shown, and still has to be changed to save (spec addendum §7.2)", async () => {
    stubActivity([], { view: view({ fields: { ...FIELDS, startTime: "09:07" } }) });
    renderActivity("/calendar/activities/20001");
    const st = (await screen.findByRole("combobox", { name: "Start time" })) as HTMLSelectElement;
    expect(st).toHaveValue("09:07");
    expect(st.selectedOptions[0]).toHaveTextContent("9:07 AM (not a 5-minute step)");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(within(await screen.findByRole("alert")).getByRole("link", { name: "Use 5-minute steps" })).toHaveAttribute("href", "#activity-startTime");
  });

  it("needs-review markup reaches the time as well as the date", async () => {
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ needsReview: ["start_date"] }) });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("combobox", { name: "Start time" })).toHaveAccessibleDescription(/Changed: needs review/);
  });

  describe("signed out mid-edit", () => {
    const signedOutOnSave = (url: string, init?: RequestInit) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(401, { error: "Sign in again" }) : undefined);
    const drafts = () => Object.keys(sessionStorage).filter((k) => k.startsWith("gcpe-calendar-draft:"));
    /** Types a change, then the session expires on Save: the user is sent to sign in. */
    async function loseTheSession() {
      stubActivity([], { other: signedOutOnSave });
      const { router } = renderActivity("/calendar/activities/20001?return=%2Fcalendar");
      await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
      cleanup();
      vi.unstubAllGlobals();
    }
    afterEach(() => sessionStorage.clear());

    it("keeps the changes, and the same activity opened again brings them back with the version they were based on", async () => {
      await loseTheSession();
      expect(drafts()).toHaveLength(1);
      const calls: Call[] = [];
      stubActivity(calls, {
        view: () => view({ version: 5 }),
        other: (url, init) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(409, { code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" }) : undefined),
      });
      renderActivity("/calendar/activities/20001?return=%2Fcalendar");
      expect(await screen.findByText("Your unsaved changes were restored.")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Someone else changed this activity — reload to see their changes");
      expect(JSON.parse(String(calls.find(isPut)!.init!.body))).toMatchObject({ version: 3, venue: "Sample hall" });
      await userEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue(""));
      expect(drafts()).toHaveLength(0);
    });

    it("a save clears the kept changes", async () => {
      await loseTheSession();
      stubActivity([], { other: savedOk });
      renderActivity("/calendar/activities/20001?return=%2Fcalendar");
      await screen.findByText("Your unsaved changes were restored.");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("heading", { level: 1, name: "Sample list" });
      expect(drafts()).toHaveLength(0);
    });

    it("leaving without saving clears the kept changes", async () => {
      await loseTheSession();
      stubActivity([]);
      renderActivity("/calendar/activities/20001?return=%2Fcalendar");
      await screen.findByText("Your unsaved changes were restored.");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
      await screen.findByRole("heading", { level: 1, name: "Sample list" });
      expect(drafts()).toHaveLength(0);
    });

    it("another activity doesn't pick up the kept changes", async () => {
      await loseTheSession();
      stubActivity([], { view: (id) => view({ id }) });
      renderActivity("/calendar/activities/20002");
      await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20002" });
      expect(screen.queryByText("Your unsaved changes were restored.")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("");
    });
  });
});
