import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClonePrefill } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME } from "../list/fixtures";
import { FIELDS, renderActivity, stubActivity, view, type Call } from "./fixtures";

const ACTIVITY = "/calendar/api/activities/20001";
const NEW = `/calendar/activities/new?return=${encodeURIComponent("/calendar")}`;
const created = (url: string, init?: RequestInit) =>
  url === "/calendar/api/activities" && init?.method === "POST" ? jsonResponse(201, { id: 20009, activity: view({ id: 20009 }), warnings: [] }) : undefined;
const posted = (calls: Call[]) => calls.filter((c) => c.init?.method === "POST" && !c.url.endsWith("/lock/release"));
const startDate = () => screen.getByLabelText(/^Start date/);
const endDate = () => screen.getByLabelText(/^End date/);
const PREFILL: ClonePrefill = { sourceId: 20001, sourceLabel: "HLTH-20001", fields: { ...FIELDS, title: "Sample source", comments: "", nrDate: null, nrTime: null } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Clone opens an unsaved, pre-filled New activity form (owner, 2026-10-31; suite review CAL-1)", () => {
  const cloneStub = (calls: Call[], over: Partial<ClonePrefill> = {}) =>
    stubActivity(calls, {
      view: (id) => view({ id }),
      other: (url, init) => {
        if (url === `${ACTIVITY}/clone` && (init?.method ?? "GET") === "GET") return jsonResponse(200, { ...PREFILL, ...over });
        return created(url, init);
      },
    });

  it("Clone creates nothing: it opens New activity holding the copy, and says it isn't saved", async () => {
    const calls: Call[] = [];
    cloneStub(calls);
    const { router } = renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Clone" }));
    expect(await screen.findByRole("heading", { level: 1, name: "New activity" })).toBeInTheDocument();
    expect(screen.getByText("This is an unsaved copy of HLTH-20001. Nothing is created until you choose Save. Cancel leaves no copy behind.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample source");
    expect(screen.getByRole("combobox", { name: "Comm Contact" })).toHaveValue("11");
    expect(router.state.location.pathname).toBe("/calendar/activities/new");
    expect(posted(calls)).toHaveLength(0);
  });

  it("Cancel leaves without creating anything", async () => {
    const calls: Call[] = [];
    cloneStub(calls);
    renderActivity(`/calendar/activities/new?clone=20001&return=${encodeURIComponent("/calendar")}`);
    await screen.findByText(/unsaved copy of HLTH-20001/);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sample list" })).toBeInTheDocument();
    expect(posted(calls)).toHaveLength(0);
  });

  it("Save creates it, naming the source so its history says it was cloned, and opens it", async () => {
    const calls: Call[] = [];
    cloneStub(calls);
    renderActivity(`/calendar/activities/new?clone=20001&return=${encodeURIComponent("/calendar")}`);
    await screen.findByText(/unsaved copy of HLTH-20001/);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20009" })).toBeInTheDocument();
    expect(screen.getByText("Cloned HLTH-20001 as HLTH-20009.")).toBeInTheDocument();
    const [post] = posted(calls);
    expect(post!.url).toBe("/calendar/api/activities");
    expect(JSON.parse(String(post!.init!.body))).toMatchObject({ title: "Sample source", clonedFrom: 20001 });
  });

  it("a save the server refuses keeps the copy on screen and names the problem", async () => {
    stubActivity([], {
      other: (url, init) => {
        if (url === `${ACTIVITY}/clone`) return jsonResponse(200, PREFILL);
        if (url === "/calendar/api/activities" && init?.method === "POST") {
          return jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "contactMinistryKey", message: "That ministry is no longer active" }] });
        }
        return undefined;
      },
    });
    renderActivity(`/calendar/activities/new?clone=20001&return=${encodeURIComponent("/calendar")}`);
    await screen.findByText(/unsaved copy of HLTH-20001/);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("link", { name: "That ministry is no longer active" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample source");
  });

  it("a source that can't be cloned any more says why, with a way back", async () => {
    stubActivity([], {
      other: (url) => (url === `${ACTIVITY}/clone` ? jsonResponse(409, { code: "deleted", error: "This activity has been deleted" }) : undefined),
    });
    renderActivity(`/calendar/activities/new?clone=20001&return=${encodeURIComponent("/calendar")}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("This activity has been deleted");
    expect(screen.getByRole("link", { name: "Back to the Calendar" })).toBeInTheDocument();
  });

  it("End follows Start only on a one-day copy; a copy that runs several days keeps its own End", async () => {
    cloneStub([], { fields: { ...PREFILL.fields, startDate: "2031-11-10", endDate: "2031-11-12" } });
    renderActivity(`/calendar/activities/new?clone=20001&return=${encodeURIComponent("/calendar")}`);
    await screen.findByText(/unsaved copy/);
    fireEvent.change(startDate(), { target: { value: "2031-12-01" } });
    expect(endDate()).toHaveValue("2031-11-12");
  });
});

describe("New activity prefills, as legacy (Activity.aspx:1528-1537, Activity.aspx.cs:339-368; suite review CAL-2)", () => {
  it("Comm Contact starts as the signed-in user when they are a contact of the lead ministry", async () => {
    stubActivity([]);
    renderActivity(NEW);
    await screen.findByRole("heading", { level: 1, name: "New activity" });
    expect(screen.getByRole("combobox", { name: "Lead Ministry" })).toHaveValue("health");
    expect(screen.getByRole("combobox", { name: "Comm Contact" })).toHaveValue("11");
  });

  it("a new lead ministry picks the user again where they are a contact, until they choose a contact themselves", async () => {
    stubActivity([], { me: { ...HQ_ADMIN_ME, userId: "u2" }, config: HQ_ADMIN_CONFIG });
    renderActivity(NEW);
    await screen.findByRole("heading", { level: 1, name: "New activity" });
    const ministry = screen.getByRole("combobox", { name: "Lead Ministry" });
    const contact = screen.getByRole("combobox", { name: "Comm Contact" });
    expect(contact).toHaveValue("");
    await userEvent.selectOptions(ministry, "finance");
    expect(contact).toHaveValue("12");
    await userEvent.selectOptions(ministry, "health");
    expect(contact).toHaveValue("");
    await userEvent.selectOptions(contact, "13");
    await userEvent.selectOptions(ministry, "finance");
    // Their own choice went with the old ministry; nothing is picked for them now.
    expect(contact).toHaveValue("");
  });

  it("End date follows Start date until the user sets End themselves", async () => {
    stubActivity([]);
    renderActivity(NEW);
    await screen.findByRole("heading", { level: 1, name: "New activity" });
    fireEvent.change(startDate(), { target: { value: "2031-11-10" } });
    expect(endDate()).toHaveValue("2031-11-10");
    fireEvent.change(startDate(), { target: { value: "2031-11-11" } });
    expect(endDate()).toHaveValue("2031-11-11");
    fireEvent.change(endDate(), { target: { value: "2031-11-13" } });
    fireEvent.change(startDate(), { target: { value: "2031-11-12" } });
    expect(endDate()).toHaveValue("2031-11-13");
  });

  it("on an existing activity, End stays where it is", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20001" });
    fireEvent.change(startDate(), { target: { value: "2031-11-09" } });
    expect(endDate()).toHaveValue("2031-11-10");
  });
});

describe("a linked release is planned against the activity (suite review CAL-4)", () => {
  const RELEASE = { releaseId: "r1", type: "release", status: "scheduled", reference: "2031HLTH0001", publishAt: "2031-11-10T17:00:00.000Z", releasedAt: null };
  const warning = () => screen.queryByText(/A release is planned against HLTH-20001/);
  const saved = (url: string, init?: RequestInit) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(200, { id: 20001, activity: view({ version: 4 }), warnings: [] }) : undefined);

  it("changing the date warns beside Save, and the save's notice repeats it", async () => {
    stubActivity([], { view: view({ releases: [RELEASE] }), other: saved });
    renderActivity(`/calendar/activities/20001?return=${encodeURIComponent("/calendar")}`);
    await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20001" });
    expect(warning()).toBeNull();
    fireEvent.change(startDate(), { target: { value: "2031-11-09" } });
    const text = /^A release is planned against HLTH-20001 \(Release 2031HLTH0001: Scheduled, Nov 10, 2031 \d+:00 AM\)\. Changing the date or time here doesn't move the release\. Tell the release editor\.$/;
    expect(screen.getByText(text)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText((t) => t.startsWith("Saved HLTH-20001. A release is planned against HLTH-20001 (Release 2031HLTH0001: Scheduled"))).toBeInTheDocument();
  });

  it("says nothing for a change that isn't a date or time, or when the release has already gone out", async () => {
    stubActivity([], { view: view({ releases: [{ ...RELEASE, status: "published", releasedAt: "2031-11-10T17:00:00.000Z" }] }) });
    renderActivity("/calendar/activities/20001");
    await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20001" });
    fireEvent.change(startDate(), { target: { value: "2031-11-12" } });
    expect(warning()).toBeNull();
    cleanup();
    stubActivity([], { view: view({ releases: [RELEASE] }) });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Title" }), " renamed");
    expect(warning()).toBeNull();
  });
});
