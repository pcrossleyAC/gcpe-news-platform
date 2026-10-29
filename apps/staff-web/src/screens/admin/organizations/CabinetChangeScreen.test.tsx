import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import axe from "axe-core";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CabinetChangeScreen } from "./CabinetChangeScreen";

const base = {
  isHq: false,
  isPublic: true,
  parentKey: null,
  minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
  url: null,
  social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [],
  serviceLinks: [],
  sectorKeys: [],
  successorKeys: [],
};
const org = (key: string, displayName: string, abbreviation: string | null, sortOrder: number, updatedAt: string, isActive = true) =>
  ({ ...base, key, displayName, abbreviation, sortOrder, isActive, updatedAt }) as unknown as OrgRecord;

const HEALTH = org("health", "Health", "HLTH", 1, "2026-10-01T10:00:00.000Z");
const JOBS = org("jobs", "Jobs", null, 2, "2026-10-02T10:00:00.000Z");
const FINANCE = org("finance", "Finance", "FIN", 3, "2026-10-03T10:00:00.000Z");
const ORGS = [HEALTH, JOBS, FINANCE];

const SESSION = { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() };

const change = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  status: "draft",
  scheduledFor: null,
  operations: [],
  createdBy: "Pat",
  publishedAt: null,
  error: null,
  updatedAt: "2026-10-27T10:00:00.000Z",
  ...over,
});

const RENAME = { op: "update", key: "health", expectedUpdatedAt: HEALTH.updatedAt, patch: { displayName: "Health and Wellness" } };

type Call = { url: string; init?: RequestInit };
let overrides: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {};
let stored: ReturnType<typeof change> | null = null;
let currentOrgs: OrgRecord[] = ORGS;

function stub(calls: Call[], roles = ["Core.Admin"]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const method = init?.method ?? "GET";
      const o = overrides[`${method} ${url}`];
      if (o) return o(init);
      if (url === "/core/auth/session") return jsonResponse(200, { ...SESSION, user: { ...SESSION.user, roles } });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/core/api/organizations") return jsonResponse(200, currentOrgs);
      if (url === "/core/api/cabinet-change" && method === "GET") return stored ? jsonResponse(200, stored) : jsonResponse(404, { error: "no open cabinet change" });
      if (url === "/core/api/cabinet-change" && method === "PUT") {
        const { operations } = JSON.parse(init!.body as string) as { operations: unknown[] };
        stored = change({ ...(stored ?? {}), operations, status: "draft", scheduledFor: null, error: null, updatedAt: new Date().toISOString() });
        return jsonResponse(200, stored);
      }
      if (url.endsWith("/succession-preview")) return jsonResponse(200, { staff: 3, abbreviation: null });
      if (url.startsWith("/nod/api/subscribers/count")) return jsonResponse(200, { count: 120 });
      if (url.startsWith("/calendar/api/succession/")) return jsonResponse(200, { activities: 4, contacts: 2 });
      if (url.endsWith("/open-releases")) return jsonResponse(200, { drafts: [{ id: "r1", headline: "Draft" }], notMoved: [] });
      throw new Error(`unhandled: ${method} ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <CabinetChangeScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

const puts = (calls: Call[]) =>
  calls.filter((c) => c.url === "/core/api/cabinet-change" && c.init?.method === "PUT").map((c) => (JSON.parse(c.init!.body as string) as { operations: unknown[] }).operations);
const posts = (calls: Call[], path: string) => calls.filter((c) => c.url === `/core/api/cabinet-change/${path}` && c.init?.method === "POST");

const CLEAN_PREVIEW = {
  diff: [{ key: "health", displayName: "Health and Wellness", kind: "changed", field: "displayName", from: "Health", to: "Health and Wellness" }],
  resulting: [{ ...HEALTH, displayName: "Health and Wellness" }, JOBS, FINANCE],
  problems: [],
};

async function preview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Preview/ }));
  return screen.findByRole("heading", { name: "What will change" });
}

describe("CabinetChangeScreen", () => {
  afterEach(() => {
    cleanup();
    overrides = {};
    stored = null;
    currentOrgs = ORGS;
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("tells anyone but a Core.Admin they can't use it, without loading the change", async () => {
    const calls: Call[] = [];
    stub(calls, ["NRMS.SiteEditor"]);
    renderScreen();
    await screen.findByText(/don.t have permission/);
    expect(calls.some((c) => c.url.startsWith("/core/api/cabinet-change"))).toBe(false);
  });

  it("add rename, create, merge; preview shows diff and problems; publish posts once", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    stub(calls);
    renderScreen();
    await screen.findByText(/No changes yet/);

    // Rename Health.
    await user.click(screen.getByRole("button", { name: "Rename or change a ministry" }));
    const rename = screen.getByRole("form", { name: "Rename or change a ministry" });
    await user.selectOptions(within(rename).getByLabelText("Ministry"), "health");
    const name = within(rename).getByLabelText("Name");
    expect(name).toHaveValue("Health");
    await user.clear(name);
    await user.type(name, "Health and Wellness");
    await user.click(within(rename).getByRole("button", { name: "Add this change" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toEqual([RENAME]);
    expect(await screen.findByRole("status")).toHaveTextContent("Added: Rename Health to Health and Wellness.");

    // Create the merged ministry.
    await user.click(screen.getByRole("button", { name: "Add a new ministry" }));
    const create = screen.getByRole("form", { name: "Add a new ministry" });
    await user.type(within(create).getByLabelText("Name"), "Jobs and Economy");
    await user.type(within(create).getByLabelText("Abbreviation (optional)"), "je");
    await user.type(within(create).getByLabelText("Minister (optional)"), "Sam Lee");
    await user.click(within(create).getByRole("button", { name: "Add this change" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1]![1]).toEqual({ op: "create", ref: "Jobs and Economy", displayName: "Jobs and Economy", abbreviation: "JE", minister: { name: "Sam Lee" } });

    // Merge: Jobs and Finance both hand over to the new ministry.
    for (const [key, n] of [["jobs", 3], ["finance", 4]] as const) {
      await user.click(screen.getByRole("button", { name: "Hand over a ministry" }));
      const handOver = screen.getByRole("form", { name: "Hand over a ministry" });
      await user.selectOptions(within(handOver).getByLabelText("Ministry to hand over"), key);
      await user.selectOptions(within(handOver).getByLabelText("Successor"), "ref:Jobs and Economy");
      // The hand-over's own checkboxes, with the counts, all on by default.
      expect(await within(handOver).findByLabelText("Move 120 subscribers to Jobs and Economy.")).toBeChecked();
      expect(within(handOver).getByLabelText(/Move 3 staff from/)).toBeChecked();
      await user.click(within(handOver).getByRole("button", { name: "Add this change" }));
      await waitFor(() => expect(puts(calls)).toHaveLength(n));
    }
    const ops = puts(calls)[3]!;
    expect(ops).toHaveLength(4);
    expect(ops[2]).toEqual({
      op: "succeed",
      key: "jobs",
      expectedUpdatedAt: JOBS.updatedAt,
      successors: [{ ref: "Jobs and Economy" }],
      moves: { moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: false },
    });
    expect(ops[3]).toMatchObject({ op: "succeed", key: "finance", successors: [{ ref: "Jobs and Economy" }] });
    const list = screen.getByRole("list", { name: "Changes in this cabinet change" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(list).toHaveTextContent("Hand Finance over to Jobs and Economy (new)");

    // A preview with a problem: the diff is shown, the problem names the change, and nothing can be published.
    overrides["POST /core/api/cabinet-change/preview"] = () =>
      jsonResponse(200, { ...CLEAN_PREVIEW, problems: [{ op: 1, message: "The abbreviation JE is already used by Finance." }] });
    await preview(user);
    expect(screen.getByRole("table", { name: "What will change" })).toHaveTextContent(/Health and Wellness\s*Name\s*Health\s*Health and Wellness/);
    expect(screen.getByRole("alert")).toHaveTextContent("Change 2: The abbreviation JE is already used by Finance.");
    expect(screen.queryByRole("button", { name: "Publish now…" })).toBeNull();
    expect(screen.getByRole("list", { name: "Ministries after this change" })).toHaveTextContent("Health and Wellness");

    // A clean preview: publish, confirm, and two clicks before React re-renders (so the button is
    // not yet disabled) still post once: the in-flight ref guard, not just `disabled`.
    overrides["POST /core/api/cabinet-change/preview"] = () => jsonResponse(200, CLEAN_PREVIEW);
    await preview(user);
    expect(screen.queryByRole("alert")).toBeNull();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    overrides["POST /core/api/cabinet-change/publish"] = async () => {
      await gate;
      return jsonResponse(200, { result: "published" });
    };
    await user.click(screen.getByRole("button", { name: "Publish now…" }));
    const yes = screen.getByRole("button", { name: "Yes, publish now" });
    expect(yes.closest("[role=group]")).toHaveFocus();
    act(() => {
      yes.click();
      yes.click();
    });
    release();
    expect(await screen.findByText(/The cabinet change is published/)).toBeInTheDocument();
    expect(posts(calls, "publish")).toHaveLength(1);
  });

  it("schedule shows the Pacific time", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    stored = change({ operations: [RENAME] });
    stub(calls);
    overrides["POST /core/api/cabinet-change/preview"] = () => jsonResponse(200, CLEAN_PREVIEW);
    overrides["POST /core/api/cabinet-change/schedule"] = (init) => {
      // Core converts the BC wall-clock time itself (NG-R15) and returns both readings.
      const { scheduledForLocal } = JSON.parse(init!.body as string) as { scheduledForLocal: string };
      stored = change({ operations: [RENAME], status: "scheduled", scheduledFor: "2099-11-18T18:00:00.000Z", scheduledForLocal });
      return jsonResponse(200, stored);
    };
    renderScreen();
    await screen.findByText(/Rename Health to Health and Wellness/);
    await preview(user);
    // Schedule… moves focus into the form; Cancel brings it back.
    await user.click(screen.getByRole("button", { name: "Schedule…" }));
    expect(screen.getByLabelText("Date")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Schedule…" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Schedule…" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-11-18" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "11:00" } });
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(posts(calls, "schedule")).toHaveLength(1));
    // The wall-clock time as typed: the browser converts nothing.
    expect(JSON.parse(posts(calls, "schedule")[0]!.init!.body as string)).toEqual({ scheduledForLocal: "2099-11-18T11:00" });
    expect(await screen.findByText("Publishes on November 18, 2099 at 11:00 a.m. Pacific.")).toBeInTheDocument();
  });

  it("schedule refusals say nothing was scheduled: past, problems, and a change no longer open", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    stored = change({ operations: [RENAME] });
    stub(calls);
    overrides["POST /core/api/cabinet-change/preview"] = () => jsonResponse(200, CLEAN_PREVIEW);
    renderScreen();
    await screen.findByText(/Rename Health to Health and Wellness/);
    const attempt = async () => {
      await preview(user);
      await user.click(screen.getByRole("button", { name: "Schedule…" }));
      fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-11-18" } });
      fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "11:00" } });
      await user.click(screen.getByRole("button", { name: "Schedule" }));
    };

    overrides["POST /core/api/cabinet-change/schedule"] = () => jsonResponse(422, { result: "past", error: "Choose a time in the future." });
    await attempt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was scheduled. Choose a time in the future.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    overrides["POST /core/api/cabinet-change/schedule"] = () =>
      jsonResponse(422, { result: "invalid", problems: [{ op: 0, message: "Health was changed by someone else since this draft was started." }] });
    await attempt();
    await waitFor(() => expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([
      "Nothing was scheduled. Fix the problems listed under Preview, then try again.",
      expect.stringContaining("Change 1: Health was changed by someone else"),
    ]));

    overrides["POST /core/api/cabinet-change/preview"] = () => jsonResponse(200, CLEAN_PREVIEW);
    overrides["POST /core/api/cabinet-change/schedule"] = () => jsonResponse(404, { error: "no open cabinet change" });
    await attempt();
    expect(await screen.findByText("This cabinet change is no longer open. Someone else may have published or discarded it.")).toBeInTheDocument();
  });

  it("publish refused because the change is no longer open says so and reloads", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    stored = change({ operations: [RENAME] });
    stub(calls);
    overrides["POST /core/api/cabinet-change/preview"] = () => jsonResponse(200, CLEAN_PREVIEW);
    overrides["POST /core/api/cabinet-change/publish"] = () => {
      stored = null;
      return jsonResponse(404, { result: "not-open" });
    };
    renderScreen();
    await screen.findByText(/Rename Health to Health and Wellness/);
    await preview(user);
    await user.click(screen.getByRole("button", { name: "Publish now…" }));
    await user.click(screen.getByRole("button", { name: "Yes, publish now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This cabinet change is no longer open.");
    expect(await screen.findByText(/No changes yet/)).toBeInTheDocument();
  });

  it("a scheduled change whose time has passed reads as being published, and refreshes", async () => {
    stored = change({ operations: [RENAME], status: "scheduled", scheduledFor: "2020-01-01T08:00:00.000Z", scheduledForLocal: "2020-01-01T00:00" });
    stub([]);
    renderScreen();
    expect(await screen.findByText(/it is being published now/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/^Publishes on/)).toBeNull();
    stored = null;
    // The focus listener is attached by an effect that runs after the render above; on a slow runner
    // a single focus can fire before it exists (the 15 s poll is past the timeout). Refocus until it lands.
    await waitFor(
      () => {
        act(() => {
          window.dispatchEvent(new Event("focus"));
        });
        expect(screen.getByText("The scheduled cabinet change has been published.")).toBeInTheDocument();
      },
      { timeout: 5000, interval: 100 },
    );
  });

  it("an already-scheduled change shows its time, and one that failed at its time says why", async () => {
    // The time shown is Core's own reading (scheduledForLocal), not this browser's: here they
    // deliberately disagree by an hour, as with a browser whose tzdata predates BC's 2026 change.
    stored = change({ operations: [RENAME], status: "scheduled", scheduledFor: "2099-11-19T07:00:00.000Z", scheduledForLocal: "2099-11-18T23:00" });
    stub([]);
    renderScreen();
    expect(await screen.findByText("Publishes on November 18, 2099 at 11:00 p.m. Pacific.")).toBeInTheDocument();
    cleanup();

    stored = change({ operations: [RENAME], status: "scheduled", scheduledFor: "2099-11-19T07:00:00.000Z", scheduledForLocal: "2099-11-19T00:00" });
    stub([]);
    renderScreen();
    expect(await screen.findByText("Publishes on November 19, 2099 at 12:00 a.m. Pacific.")).toBeInTheDocument();
    cleanup();

    stored = change({ operations: [RENAME], error: "Not published at the scheduled time: Health was changed by someone else since this draft was started." });
    stub([]);
    renderScreen();
    expect(await screen.findByText(/Not published at the scheduled time: Health was changed/)).toBeInTheDocument();
  });

  it("stale result shows the copy", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    stored = change({ operations: [RENAME] });
    stub(calls);
    overrides["POST /core/api/cabinet-change/preview"] = () => jsonResponse(200, CLEAN_PREVIEW);
    overrides["POST /core/api/cabinet-change/publish"] = () => jsonResponse(409, { result: "stale", key: "health" });
    renderScreen();
    await screen.findByText(/Rename Health to Health and Wellness/);
    await preview(user);
    // Someone else saved Health after this draft was started.
    currentOrgs = [{ ...HEALTH, updatedAt: "2026-10-27T12:00:00.000Z" } as OrgRecord, JOBS, FINANCE];
    await user.click(screen.getByRole("button", { name: "Publish now…" }));
    await user.click(screen.getByRole("button", { name: "Yes, publish now" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Health was changed by someone else since this draft was started. Review it and publish again.");
    expect(alert.parentElement).toHaveFocus();

    // The screen reloads the ministries: the change is flagged, and keeping it re-bases it on Health as it is now.
    expect(await screen.findByText("Changed by someone else since you added this.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep change 1" }));
    await waitFor(() => expect(puts(calls).at(-1)).toEqual([{ ...RENAME, expectedUpdatedAt: "2026-10-27T12:00:00.000Z" }]));
    expect(screen.queryByText("Changed by someone else since you added this.")).toBeNull();
  });

  it("removing a change saves the draft without it; discarding cancels the change", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    stored = change({ operations: [RENAME, { op: "create", ref: "Tourism", displayName: "Tourism" }] });
    stub(calls);
    overrides["POST /core/api/cabinet-change/cancel"] = () => new Response(null, { status: 204 });
    renderScreen();
    await screen.findByText(/Add a new ministry: Tourism/);
    await user.click(screen.getByRole("button", { name: "Remove change 1" }));
    await waitFor(() => expect(puts(calls)).toEqual([[{ op: "create", ref: "Tourism", displayName: "Tourism" }]]));
    await user.click(screen.getByRole("button", { name: "Discard this cabinet change…" }));
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.getByRole("button", { name: "Discard this cabinet change…" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Discard this cabinet change…" }));
    await user.click(screen.getByRole("button", { name: "Yes, discard it" }));
    expect(await screen.findByText(/discarded/)).toBeInTheDocument();
    expect(posts(calls, "cancel")).toHaveLength(1);
    expect(screen.getByText(/No changes yet/)).toBeInTheDocument();
  });

  it("form problems show beside their fields, and focus goes to the first one", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    stub(calls);
    renderScreen();
    await screen.findByText(/No changes yet/);
    await user.click(screen.getByRole("button", { name: "Add a new ministry" }));
    const create = screen.getByRole("form", { name: "Add a new ministry" });
    await user.type(within(create).getByLabelText("Abbreviation (optional)"), "x");
    await user.click(within(create).getByRole("button", { name: "Add this change" }));
    const name = within(create).getByLabelText("Name");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter the new ministry's name.");
    expect(within(create).getByLabelText("Abbreviation (optional)")).toHaveAccessibleDescription(/Use 2 to 10 capital letters or digits, e.g. HLTH\.$/);
    expect(puts(calls)).toHaveLength(0);

    await user.type(name, "Health");
    await user.click(within(create).getByRole("button", { name: "Add this change" }));
    expect(name).toHaveAccessibleDescription("Health already exists.");
  });

  it("removing a new ministry also removes the hand-overs to it, and says so", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    const toTourism = (key: string, at: string) => ({ op: "succeed", key, expectedUpdatedAt: at, successors: [{ ref: "Tourism" }], moves: { moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: false } });
    stored = change({ operations: [RENAME, { op: "create", ref: "Tourism", displayName: "Tourism" }, toTourism("jobs", JOBS.updatedAt), toTourism("finance", FINANCE.updatedAt)] });
    stub(calls);
    renderScreen();
    await screen.findByText(/Hand Finance over to Tourism/);
    await user.click(screen.getByRole("button", { name: "Remove change 2" }));
    await waitFor(() => expect(puts(calls)).toEqual([[RENAME]]));
    expect(screen.getByRole("status")).toHaveTextContent("Removed change 2. The hand-overs to Tourism were removed too: Jobs, Finance.");
  });

  it("has no serious axe violations with changes, a preview and the schedule picker open", async () => {
    const user = userEvent.setup();
    stored = change({
      operations: [
        RENAME,
        { op: "succeed", key: "jobs", expectedUpdatedAt: JOBS.updatedAt, successors: [{ key: "finance" }], moves: { moveSubscribers: true, moveStaff: true, moveCalendar: false, moveDrafts: true, takeAbbreviation: false } },
      ],
    });
    stub([]);
    overrides["POST /core/api/cabinet-change/preview"] = () => jsonResponse(200, CLEAN_PREVIEW);
    const { container } = renderScreen();
    await screen.findByText(/Hand Jobs over to Finance/);
    await preview(user);
    await user.click(screen.getByRole("button", { name: "Schedule…" }));
    await user.click(screen.getByRole("button", { name: "Hand over a ministry" }));
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
