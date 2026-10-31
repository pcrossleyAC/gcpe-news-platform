import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { renderWithSaveBar } from "../saveBarHarness";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { SettingsSection } from "./SettingsSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(handlers: { mediaLists?: unknown; onPut?: (url: string, body: unknown) => Response; lookups?: Record<string, unknown> } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url === "/nrms/api/media-lists") return jsonResponse(200, handlers.mediaLists ?? []);
      const lookups = handlers.lookups ?? {};
      const lookup = /^\/nrms\/api\/calendar-activities\/(\d+)$/.exec(url);
      if (lookup) return lookups[lookup[1]!] ? jsonResponse(200, lookups[lookup[1]!]) : jsonResponse(404, { error: "not found" });
      if (handlers.onPut) return handlers.onPut(url, body);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderSettings(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, readOnly = false) {
  return renderWithSaveBar(<SettingsSection view={view} setView={setView} timeZone="America/Vancouver" readOnly={readOnly} />);
}

describe("SettingsSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("reflects the release's current toSubscribers and mediaListKeys", async () => {
    stubFetch({ mediaLists: [{ key: "list1", displayName: "List One", sortOrder: 1, isActive: true }] });
    renderSettings(
      releaseView({
        type: "release",
        publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: true },
        mediaListKeys: ["list1"],
      }),
    );
    expect(await screen.findByLabelText("List One")).toBeChecked();
    expect(screen.getByLabelText("Send to News On Demand subscribers")).toBeChecked();
  });

  it("never offers a retired media list the release doesn't already target", async () => {
    stubFetch({
      mediaLists: [
        { key: "list1", displayName: "List One", sortOrder: 1, isActive: true },
        { key: "old-desk", displayName: "Old desk", sortOrder: 2, isActive: false },
      ],
    });
    renderSettings(releaseView({ type: "release", mediaListKeys: [] }));
    expect(await screen.findByLabelText("List One")).toBeInTheDocument();
    expect(screen.queryByText(/Old desk/)).not.toBeInTheDocument();
  });

  it("shows a retired list the release already targets as a disabled, ticked \"(retired)\" box, and keeps it on save", async () => {
    const calls = stubFetch({
      mediaLists: [
        { key: "list1", displayName: "List One", sortOrder: 1, isActive: true },
        { key: "old-desk", displayName: "Old desk", sortOrder: 2, isActive: false },
      ],
      onPut: () => jsonResponse(200, releaseView({ version: 2 })),
    });
    const v = releaseView({ type: "release", version: 1, mediaListKeys: ["old-desk"], publishOptions: { toWeb: true, toSubscribers: false, toMediaLists: true } });
    renderSettings(v);
    const retired = await screen.findByLabelText("Old desk (retired)");
    expect(retired).toBeChecked();
    expect(retired).toBeDisabled();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("List One"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`)?.body).toMatchObject({ mediaListKeys: ["old-desk", "list1"] }));
  });

  // forms-b #2: the server sends the media email to the ticked lists, whatever a "Send to media
  // distribution lists" box said (apps/nrms/src/releases/service.ts saveSettings), so there's no
  // such box: the lists alone say who gets it.
  it("has no separate Send to media distribution lists box; the ticked lists decide, and the section says so", async () => {
    const calls = stubFetch({
      mediaLists: [{ key: "list1", displayName: "List One", sortOrder: 1, isActive: true }],
      onPut: () => jsonResponse(200, releaseView({ version: 2 })),
    });
    const v = releaseView({ type: "release", version: 1, mediaListKeys: [], publishOptions: { toWeb: true, toSubscribers: false, toMediaLists: false } });
    renderSettings(v);
    const list = await screen.findByLabelText("List One");
    expect(screen.queryByLabelText("Send to media distribution lists")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Media distribution lists" })).toHaveAccessibleDescription("The lists you tick get the media email when this is published. With none ticked, no media email goes out.");

    const user = userEvent.setup();
    await user.click(list);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`)?.body).toMatchObject({ mediaListKeys: ["list1"], toMediaLists: true }));
  });

  // forms-b fix round 1, finding 1: publishing follows the saved flag (publishOptions.toMediaLists),
  // which an imported release can have off while lists are ticked. The server sets the flag from the
  // lists on any settings save, so the section counts as unsaved and says so, instead of the hint.
  describe("an imported release with lists ticked but the media email off", () => {
    const stale = () => releaseView({ type: "release", version: 1, releasedAt: null, mediaListKeys: ["list1"], publishOptions: { toWeb: true, toSubscribers: false, toMediaLists: false } });
    const LISTS = [{ key: "list1", displayName: "List One", sortOrder: 1, isActive: true }];

    it("an editor sees a warning, not the hint, and the section is unsaved until Save sends the flag on", async () => {
      const calls = stubFetch({ mediaLists: LISTS, onPut: () => jsonResponse(200, releaseView({ version: 2, mediaListKeys: ["list1"], publishOptions: { toWeb: true, toSubscribers: false, toMediaLists: true } })) });
      const v = stale();
      renderSettings(v);
      await screen.findByLabelText("List One");
      const group = screen.getByRole("group", { name: "Media distribution lists" });
      expect(group).toHaveAccessibleDescription("As saved, these lists won't get the media email. Save Publish settings and they will.");
      expect(screen.queryByText(/The lists you tick/)).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Publish settings/ })).toHaveTextContent("Unsaved");

      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`)?.body).toMatchObject({ mediaListKeys: ["list1"], toMediaLists: true }));
    });

    it("a viewer sees a plain read-only line", async () => {
      stubFetch({ mediaLists: LISTS });
      renderSettings(stale(), () => {}, true);
      await screen.findByLabelText("List One");
      expect(screen.getByRole("group", { name: "Media distribution lists" })).toHaveAccessibleDescription("As saved, these lists won't get the media email.");
      expect(screen.getByRole("heading", { name: /Publish settings/ })).not.toHaveTextContent("Unsaved");
    });

    it("the normal case is unchanged: the hint, and nothing unsaved", async () => {
      stubFetch({ mediaLists: LISTS });
      renderSettings(releaseView({ type: "release", mediaListKeys: ["list1"], publishOptions: { toWeb: true, toSubscribers: false, toMediaLists: true } }));
      await screen.findByLabelText("List One");
      expect(screen.getByRole("group", { name: "Media distribution lists" })).toHaveAccessibleDescription(/^The lists you tick/);
      expect(screen.getByRole("heading", { name: /Publish settings/ })).not.toHaveTextContent("Unsaved");
    });

    it("while it's live, no warning: a correction emails nobody", async () => {
      stubFetch({ mediaLists: LISTS });
      renderSettings(releaseView({ ...stale(), status: "published", live: true, releasedAt: "2026-01-01T00:00:00.000Z" }));
      await screen.findByLabelText("List One");
      expect(screen.queryByText(/As saved/)).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Publish settings/ })).not.toHaveTextContent("Unsaved");
    });

    // Fix round 2, finding 2: gone out before, now unpublished. A save would turn the flag on and
    // could email lists the old system already emailed, so it's said, not forced.
    it("released before and now off the site: a plain line, not forced unsaved, for editor and viewer", async () => {
      const unpublished = () => releaseView({ ...stale(), status: "approved", live: false, releasedAt: "2026-01-01T00:00:00.000Z" });
      stubFetch({ mediaLists: LISTS });
      const { unmount } = renderSettings(unpublished());
      await screen.findByLabelText("List One");
      expect(screen.getByRole("group", { name: "Media distribution lists" })).toHaveAccessibleDescription("As saved, these lists won't get the media email when it's republished.");
      expect(screen.getByRole("heading", { name: /Publish settings/ })).not.toHaveTextContent("Unsaved");
      unmount();
      renderSettings(unpublished(), () => {}, true);
      await screen.findByLabelText("List One");
      expect(screen.getByRole("group", { name: "Media distribution lists" })).toHaveAccessibleDescription("As saved, these lists won't get the media email when it's republished.");
    });

    // Fix round 2, finding 3: a retired list gets nothing either way.
    it("only retired lists ticked: says so, and isn't forced unsaved", async () => {
      stubFetch({ mediaLists: [...LISTS, { key: "old-desk", displayName: "Old desk", sortOrder: 2, isActive: false }] });
      renderSettings(releaseView({ ...stale(), mediaListKeys: ["old-desk"] }));
      await screen.findByLabelText("Old desk (retired)");
      expect(screen.getByRole("group", { name: "Media distribution lists" })).toHaveAccessibleDescription("The ticked lists are retired and won't get the media email.");
      expect(screen.getByRole("heading", { name: /Publish settings/ })).not.toHaveTextContent("Unsaved");
    });

    // Fix round 2, finding 1: an imported advisory can carry the old News On Demand bit, which the
    // server refuses for an advisory; the save sends it off, so the forced save can succeed.
    it("an imported advisory with the old News On Demand bit on saves, and the warning clears", async () => {
      const v = releaseView({ ...stale(), type: "advisory", sectors: [], publishOptions: { toWeb: false, toSubscribers: true, toMediaLists: false } });
      const saved = releaseView({ ...v, version: 2, publishOptions: { toWeb: false, toSubscribers: false, toMediaLists: true } });
      const calls = stubFetch({ mediaLists: LISTS, onPut: () => jsonResponse(200, saved) });
      let current = v;
      const { rerender } = renderSettings(v, (next) => { current = next; });
      await screen.findByLabelText("List One");
      expect(screen.getByText(/As saved, these lists won't get the media email\. Save/)).toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`)?.body).toMatchObject({ toSubscribers: false, toMediaLists: true }));
      await waitFor(() => expect(current.version).toBe(2));
      rerender(<SettingsSection view={current} setView={() => {}} timeZone="America/Vancouver" readOnly={false} />);
      await waitFor(() => expect(screen.queryByText(/As saved/)).not.toBeInTheDocument());
    });
  });

  // forms-b #10: the planned date only plans; Schedule, under Actions, sets when it goes out.
  it("names the planned date as for planning only and says Schedule sets the time", async () => {
    stubFetch();
    renderSettings(releaseView({ type: "release" }));
    const group = await screen.findByRole("group", { name: "Planned publish date (for planning only)" });
    expect(group).toBeInTheDocument();
    expect(screen.getByText("Shows on the Forecast. Nothing is published at this time: Schedule, under Actions, sets when it goes out.")).toBeInTheDocument();
  });

  it("disables the subscribers checkbox and explains why, for a type that doesn't allow it", () => {
    stubFetch();
    renderSettings(releaseView({ type: "advisory", publishOptions: { toWeb: false, toSubscribers: false, toMediaLists: false } }));
    expect(screen.getByLabelText("Send to News On Demand subscribers")).toBeDisabled();
    expect(screen.getByText("Not available for this release type.")).toBeInTheDocument();
  });

  it("hides the media distribution lists fieldset for a type that doesn't allow them", () => {
    stubFetch();
    renderSettings(releaseView({ type: "story" }));
    expect(screen.queryByText("Media distribution lists")).not.toBeInTheDocument();
  });

  it("saves with PUT /settings, including the current version and chosen media lists", async () => {
    const saved = releaseView({ version: 2 });
    const calls = stubFetch({
      mediaLists: [{ key: "list1", displayName: "List One", sortOrder: 1, isActive: true }],
      onPut: () => jsonResponse(200, saved),
    });
    const v = releaseView({ type: "release", version: 1, mediaListKeys: [] });
    const setView = vi.fn();
    renderSettings(v, setView);
    await screen.findByLabelText("List One");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("List One"));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(setView).toHaveBeenCalledWith(saved));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`);
    expect(put?.body).toMatchObject({ version: 1, mediaListKeys: ["list1"] });
  });

  // Fix round 1 follow-up: the planned publish date now sends the raw BC wall-clock string
  // (plannedPublishAtLocal), not a client-converted instant — same treatment as
  // ActionsSection's Schedule action.
  it("setting a planned date sends plannedPublishAtLocal, not a converted instant", async () => {
    const saved = releaseView({ version: 2 });
    const calls = stubFetch({ onPut: () => jsonResponse(200, saved) });
    const v = releaseView({ type: "release", version: 1, publishAt: null });
    renderSettings(v);
    await screen.findByLabelText("Date");

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-12-15" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/settings"))).toBe(true));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`);
    expect(put?.body).toMatchObject({ version: 1, plannedPublishAtLocal: "2026-12-15T14:30" });
    expect(put?.body).not.toHaveProperty("plannedPublishAt");
  });

  it("with no planned date set, saving sends plannedPublishAt: null (clears it)", async () => {
    const saved = releaseView({ version: 2 });
    const calls = stubFetch({ onPut: () => jsonResponse(200, saved) });
    const v = releaseView({ type: "release", version: 1, publishAt: null });
    renderSettings(v);
    await screen.findByLabelText("Date");

    const user = userEvent.setup();
    // Some other edit, so there is something to save.
    await user.click(screen.getByLabelText("Send to News On Demand subscribers"));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/settings"))).toBe(true));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`);
    expect(put?.body).toMatchObject({ version: 1, plannedPublishAt: null });
    expect(put?.body).not.toHaveProperty("plannedPublishAtLocal");
  });

  it("read-only disables every control and hides the Save button", async () => {
    stubFetch({ mediaLists: [{ key: "list1", displayName: "List One", sortOrder: 1, isActive: true }] });
    renderSettings(releaseView({ type: "release" }), () => {}, true);
    expect(await screen.findByLabelText("List One")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("read-only disables the planned date and time and drops the Schedule hint; an editor keeps both", async () => {
    stubFetch();
    renderSettings(releaseView({ type: "release", publishAt: "2026-12-15T17:00:00.000Z" }), () => {}, true);
    expect(await screen.findByLabelText("Date")).toBeDisabled();
    expect(screen.getByLabelText("Time (BC time)")).toBeDisabled();
    expect(screen.getByLabelText("Date")).toHaveValue("2026-12-15");
    expect(screen.queryByText(/Schedule, under Actions/)).not.toBeInTheDocument();
    cleanup();
    stubFetch();
    renderSettings(releaseView({ type: "release" }));
    expect(await screen.findByLabelText("Date")).toBeEnabled();
    expect(screen.getByLabelText("Time (BC time)")).toBeEnabled();
    expect(screen.getByText(/Schedule, under Actions/)).toBeInTheDocument();
  });

  // I2: re-sending a minute-truncated local time for a date the user never touched caused a
  // permanent 409 loop on published releases (saveSettings only tolerates a no-op change to the
  // planned time once published) — saving an untouched planned date with seconds must re-send
  // that exact stored instant, not a recomputed local/instant pair.
  it("saving without touching the planned date re-sends the exact stored instant (seconds included)", async () => {
    const saved = releaseView({ version: 2 });
    const calls = stubFetch({ onPut: () => jsonResponse(200, saved) });
    const v = releaseView({ type: "release", version: 1, publishAt: "2026-11-02T17:00:34.000Z" });
    renderSettings(v);
    await screen.findByLabelText("Date");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Send to News On Demand subscribers"));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/settings"))).toBe(true));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`);
    expect(put?.body).toMatchObject({ version: 1, plannedPublishAt: "2026-11-02T17:00:34.000Z" });
    expect(put?.body).not.toHaveProperty("plannedPublishAtLocal");
  });

  // I2: a 409 that's a ReleaseStateError (code "state"), not a real version conflict, must show
  // the server's own message — reloading wouldn't fix it — not the generic reload banner/button.
  it("a 409 with code 'state' shows the server's message, not the generic reload banner", async () => {
    const calls = stubFetch({ onPut: () => jsonResponse(409, { error: "Only a draft can have its planned date changed.", code: "state" }) });
    const v = releaseView({ type: "release", version: 1 });
    renderSettings(v);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Send to News On Demand subscribers"));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Only a draft can have its planned date changed.")).toBeInTheDocument();
    expect(screen.queryByText(/someone else changed this/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    void calls;
  });

  it("a 409 shows the reload message and keeps the user's input until Reload is clicked", async () => {
    let putCount = 0;
    const calls = stubFetch({
      onPut: () => {
        putCount += 1;
        return jsonResponse(409, { error: "version conflict" });
      },
    });
    const v = releaseView({ type: "release", version: 1 });
    renderSettings(v);
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("Send to News On Demand subscribers")); // uncheck it
    expect(screen.getByLabelText("Send to News On Demand subscribers")).not.toBeChecked();

    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();

    // The user's edit is still showing, untouched — never silently reverted or retried.
    expect(screen.getByLabelText("Send to News On Demand subscribers")).not.toBeChecked();
    expect(putCount).toBe(1);
    void calls;
  });

  it("names the saved activity: its title and the translations it requires (spec addendum §11)", async () => {
    stubFetch({
      lookups: {
        "4102": { id: 4102, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: null, ministryName: "Health", location: "Victoria", translations: ["French"], prefill: null, notEligible: "Nothing is filled in: it has ended." },
      },
    });
    const { container } = renderSettings(releaseView({ activityId: 4102 }));
    expect(await screen.findByRole("link", { name: "Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(screen.getByText("Translations required: French")).toBeInTheDocument();
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  it("a saved id the Calendar doesn't hold is a legacy link that wasn't migrated; a newly typed unknown one is named as unknown (C158, C142)", async () => {
    stubFetch();
    const { container } = renderSettings(releaseView({ activityId: 777000 }));
    expect(await screen.findByText("Legacy activity 777000, not migrated")).toBeInTheDocument();
    const legacyResults = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(legacyResults.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Calendar activity ID" });
    await user.clear(field);
    await user.type(field, "9999");
    await user.tab();
    expect(await screen.findByText("No Calendar activity has ID 9999.")).toBeInTheDocument();
  });
});
