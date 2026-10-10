import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME } from "../list/fixtures";
import { saveActivityDraft } from "./draft";
import { FIELDS, renderActivity, stubActivity, view, type Call } from "./fixtures";

const ACTIVITY = "/calendar/api/activities/20001";

describe("the activity's actions (spec addendum §8.2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("offers only what the server says this user may do", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await screen.findByRole("region", { name: "Activity actions" });
    expect(screen.getByRole("button", { name: "Clone" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("link", { name: "View changes" })).toHaveAttribute("href", "/calendar/activities/20001/changes?return=%2Fcalendar");
  });

  const reviewable = (calls: Call[]) =>
    stubActivity(calls, {
      me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ can: { edit: true, clone: true, delete: true, review: true } }),
      other: (url, init) => (url === `${ACTIVITY}/review` && init?.method === "POST" ? jsonResponse(200, view({ status: "reviewed", version: 4 })) : undefined),
    });

  it("Review and Clone wait while there are unsaved changes", async () => {
    reviewable([]);
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clone" })).toBeDisabled();
    expect(screen.getByText("Save or cancel your changes to review or clone.")).toBeInTheDocument();
  });

  it("Review sends the version and goes back", async () => {
    const calls: Call[] = [];
    reviewable(calls);
    const { router } = renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByText("Reviewed HLTH-20001.")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.url === `${ACTIVITY}/review`)!.init!.body))).toEqual({ version: 3 });
    // Replaces the editor's entry, as Save does: Back doesn't reopen it, and a reload doesn't repeat the notice.
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("Delete asks first, then sends the version and goes back", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      view: view({ can: { edit: true, clone: true, delete: true, review: false } }),
      other: (url, init) => (url === ACTIVITY && init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
    });
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete HLTH-20001?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted HLTH-20001.")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "DELETE")!.init!.body))).toEqual({ version: 3 });
  });

  it("Delete's Cancel deletes nothing", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { view: view({ can: { edit: true, clone: true, delete: true, review: false } }) });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Delete HLTH-20001?" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  });

  it("Delete with unsaved changes discards them: the list replaces the editor, and no kept draft comes back", async () => {
    saveActivityDraft("u1", { activityId: 20001, version: 3, fields: { ...FIELDS, venue: "Sample kept venue" } });
    stubActivity([], {
      view: view({ can: { edit: true, clone: true, delete: true, review: false } }),
      other: (url, init) => (url === ACTIVITY && init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
    });
    const { router } = renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    expect(await screen.findByText("Your unsaved changes were restored.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Delete HLTH-20001?" })).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted HLTH-20001.")).toBeInTheDocument();
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.queryByRole("alertdialog", { name: "Unsaved changes" })).toBeNull();
    expect(sessionStorage.getItem("gcpe-calendar-draft:u1:20001")).toBeNull();
  });

  it.each([
    ["someone else's lock (423)", jsonResponse(423, { code: "locked", error: "Sample Admin is editing this activity", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } }), "Sample Admin is editing this activity"],
    ["a newer version (409)", jsonResponse(409, { code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" }), "Someone else changed this activity — reload to see their changes"],
  ])("a refused Delete shows the server's reason and stays: %s", async (_case, answer, text) => {
    stubActivity([], {
      view: view({ can: { edit: true, clone: true, delete: true, review: false } }),
      other: (url, init) => (url === ACTIVITY && init?.method === "DELETE" ? answer : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Delete HLTH-20001?" })).getByRole("button", { name: "Delete" }));
    expect(await within(screen.getByRole("region", { name: "Activity actions" })).findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByRole("heading", { level: 1, name: "Activity HLTH-20001" })).toBeInTheDocument();
  });

  it("a refused Clone names the fields the server named", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === `${ACTIVITY}/clone` && init?.method === "POST" ? jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "contactMinistryKey", message: "That ministry is no longer active" }] }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Clone" }));
    expect(await within(screen.getByRole("region", { name: "Activity actions" })).findByRole("alert")).toHaveTextContent("That ministry is no longer active");
  });

  it("Clone opens the clone", async () => {
    stubActivity([], {
      view: (id) => view({ id }),
      other: (url, init) => (url === `${ACTIVITY}/clone` && init?.method === "POST" ? jsonResponse(201, { id: 20009, activity: view({ id: 20009 }), warnings: [] }) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Clone" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20009" })).toBeInTheDocument();
    expect(screen.getByText("Cloned HLTH-20001 as HLTH-20009.")).toBeInTheDocument();
  });

  it("a deleted activity offers HQ only Review", async () => {
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ isDeleted: true, can: { edit: false, clone: false, delete: false, review: true } }) });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("button", { name: "Review" })).toBeEnabled();
    for (const name of ["Save", "Clone", "Delete", "Watch HLTH-20001"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("link", { name: "View changes" })).toBeNull();
  });

  it("during the change freeze: no Clone or Delete; Review, the star and View changes stay (spec addendum §7.4)", async () => {
    stubActivity([], {
      me: HQ_ADMIN_ME,
      config: { ...HQ_ADMIN_CONFIG, freeze: { ...HQ_ADMIN_CONFIG.freeze, active: true, appliesToYou: true } },
      view: view({ can: { edit: true, clone: true, delete: true, review: true } }),
    });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("button", { name: "Review" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Watch HLTH-20001" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View changes" })).toBeInTheDocument();
    for (const name of ["Save", "Clone", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("a Review refused for a newer version offers Reload, and the next Review sends the new version", async () => {
    const calls: Call[] = [];
    let version = 3;
    let refuse = true;
    stubActivity(calls, {
      me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG,
      view: () => view({ version, can: { edit: true, clone: true, delete: true, review: true } }),
      other: (url, init) => {
        if (url !== `${ACTIVITY}/review` || init?.method !== "POST") return undefined;
        return refuse ? jsonResponse(409, { code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" }) : jsonResponse(200, view({ version: 5 }));
      },
    });
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    const actions = screen.getByRole("region", { name: "Activity actions" });
    expect(await within(actions).findByRole("alert")).toHaveTextContent("Someone else changed this activity");
    version = 4;
    refuse = false;
    await userEvent.click(within(actions).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(within(actions).queryByRole("alert")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Reviewed HLTH-20001.")).toBeInTheDocument();
    const reviews = calls.filter((c) => c.url === `${ACTIVITY}/review`);
    expect(JSON.parse(String(reviews.at(-1)!.init!.body))).toEqual({ version: 4 });
  });

  it("no Delete while someone else holds the lock", async () => {
    stubActivity([], { view: view({ can: { edit: true, clone: true, delete: true, review: false }, lock: { holderName: "Sample Admin", since: "2026-11-03T18:00:00.000Z", mine: false, tabId: null } }) });
    renderActivity("/calendar/activities/20001");
    await screen.findByText("Sample Admin is editing this activity", { exact: false });
    expect(screen.getByRole("button", { name: "Clone" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it.each([
    ["gone (404)", jsonResponse(404, { error: "not found" }), "This activity is no longer available."],
    ["deleted meanwhile (409)", jsonResponse(409, { code: "deleted", error: "This activity is deleted" }), "This activity is deleted"],
  ])("no Delete once a save finds the activity %s", async (_case, answer, text) => {
    stubActivity([], {
      view: view({ can: { edit: true, clone: true, delete: true, review: false } }),
      other: (url, init) => (url === ACTIVITY && init?.method === "PUT" ? answer : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(text);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("the watch star toggles and names who watches (Activity.aspx.cs:1519-1535; C176)", async () => {
    stubActivity([], {
      view: view({ watch: { isWatched: false, watcherNames: ["Sample Admin"] } }),
      other: (url, init) => (url === `${ACTIVITY}/watch` && init?.method === "PUT" ? new Response(null, { status: 204 }) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    const star = await screen.findByRole("button", { name: "Watch HLTH-20001" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(star).toHaveAccessibleDescription("Watched by Sample Admin");
    await userEvent.click(star);
    expect(star).toHaveAttribute("aria-pressed", "true");
    expect(star).toHaveAccessibleDescription("Watched by Robin Staff, Sample Admin");
  });

  it("BC Gov News lists linked releases; only an NRMS role gets the link (spec addendum §11)", async () => {
    const releases = [{ releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01", type: "release", status: "scheduled", reference: "NEWS-00001", publishAt: "2031-11-10T17:00:00.000Z", releasedAt: null }];
    stubActivity([], { view: view({ releases }) });
    renderActivity("/calendar/activities/20001");
    const news = await screen.findByRole("region", { name: "BC Gov News" });
    expect(news).toHaveTextContent("Release NEWS-00001: Scheduled, Nov 10, 2031 10:00 AM");
    expect(within(news).queryByRole("link")).toBeNull();
    cleanup();
    stubActivity([], { view: view({ releases }), roles: ["Calendar.Editor", "NRMS.Viewer"] });
    renderActivity("/calendar/activities/20001");
    expect(await within(await screen.findByRole("region", { name: "BC Gov News" })).findByRole("link")).toHaveAttribute("href", "/releases/8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01");
    cleanup();
    // Only the NRMS read roles: a role merely named NRMS.something isn't one of them.
    stubActivity([], { view: view({ releases }), roles: ["Calendar.Editor", "NRMS.Sample"] });
    renderActivity("/calendar/activities/20001");
    expect(within(await screen.findByRole("region", { name: "BC Gov News" })).queryByRole("link")).toBeNull();
  });
});
