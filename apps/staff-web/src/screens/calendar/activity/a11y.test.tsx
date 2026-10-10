import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { jsonResponse } from "../../../../test/jsonResponse";
import { CONFIG, HQ_ADMIN_CONFIG, HQ_ADMIN_ME, ME } from "../list/fixtures";
import { FIELDS, renderActivity, stubActivity, view } from "./fixtures";

async function seriousViolations(container: Element, options: axe.RunOptions = {}) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, ...options });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the activity editor in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("editing", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByRole("textbox", { name: "Title" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("HQ, with the Look Ahead fieldset overridden and review markup", async () => {
    const la = { hqComments: "", hqStatus: "new" as const, hqSection: "not_on_la" as const, longTermOutlook: true };
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ needsReview: ["title"], fields: { ...FIELDS, lookAhead: la }, lookAhead: { ...la, inferred: { kind: "section", section: "in_the_news" } } }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByRole("button", { name: "Use the inferred section" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("read-only under someone else's lock", async () => {
    stubActivity([], { view: view({ lock: { holderName: "Sample Admin", since: "2026-11-03T18:00:00.000Z", mine: false, tabId: null } }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByText("Sample Admin is editing this activity", { exact: false });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the error summary", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    await userEvent.clear(await screen.findByRole("textbox", { name: "Title" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Fix these to save");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("a new activity", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/new");
    await screen.findByRole("heading", { level: 1, name: "New activity" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  const NOT_EDITABLE = { edit: false, clone: false, delete: false, review: false };
  it.each([
    ["read-only for a Read Only user", { me: { ...ME, role: "Calendar.ReadOnly", level: 1 }, view: view({ can: NOT_EDITABLE }) }, "You can view this activity but not change it."],
    ["the freeze", { config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } }, "You cannot make content changes between 4pm-5pm."],
    ["a deleted activity", { view: view({ isDeleted: true, can: NOT_EDITABLE }) }, "This activity is deleted."],
  ])("%s", async (_state, stub, text) => {
    stubActivity([], stub);
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByText(text, { exact: false });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("gone, after a save", async () => {
    stubActivity([], { other: (url, init) => (url.endsWith("/20001") && init?.method === "PUT" ? jsonResponse(404, { error: "not found" }) : undefined) });
    const { container } = renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("This activity is no longer available.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("not found", async () => {
    stubActivity([], { view: () => jsonResponse(404, { error: "not found" }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByRole("heading", { level: 1, name: "Activity not found" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("a load failure", async () => {
    stubActivity([], { view: () => jsonResponse(500, { error: "boom" }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByText("Couldn't load this activity.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the unsaved-changes dialog", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    within(await screen.findByRole("alertdialog", { name: "Unsaved changes" })).getByRole("button", { name: "Stay" });
    // React Aria makes the page behind the dialog inert in real browsers; jsdom has no `inert`,
    // so axe sees aria-hidden alone over focusable fields. That one rule is off here, as in the
    // Subscribers dialogs' axe tests; the e2e axe sweep checks a real browser.
    expect(await seriousViolations(document.body, { rules: { "aria-hidden-focus": { enabled: false } } })).toEqual([]);
  });

  it("the delete confirmation", async () => {
    stubActivity([], { view: view({ can: { edit: true, clone: true, delete: true, review: false } }) });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await seriousViolations(dialog)).toEqual([]);
  });

  it("View changes", async () => {
    stubActivity([], {
      other: (url) =>
        url === "/calendar/api/activities/20001/changes"
          ? jsonResponse(200, [{ id: 1, at: "2026-11-03T18:00:00.000Z", actorName: "Robin Staff", action: "updated", source: "legacy_log", fields: [{ key: "title", label: "Title", old: "Sample old", new: "Sample new" }] }])
          : undefined,
    });
    const { container } = renderActivity("/calendar/activities/20001/changes");
    await screen.findByRole("heading", { level: 1, name: "Changes to HLTH-20001" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("Records with files and a refused upload", async () => {
    stubActivity([], {
      view: view({ files: [{ id: 5, fileName: "Sample brief.pdf", contentType: "application/pdf", length: 2048, uploadedAt: "2026-11-02T17:00:00.000Z", uploadedByName: "Robin Staff" }] }),
      other: (url, init) => (url.endsWith("/files") && init?.method === "POST" ? jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "files", message: "The file is empty." }] }) : undefined),
    });
    const { container } = renderActivity("/calendar/activities/20001");
    await userEvent.upload(await screen.findByLabelText("Add files"), new File([""], "Sample empty.pdf"));
    await screen.findByText("Sample empty.pdf: The file is empty.");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
