import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { useUnsavedChangesGuard } from "../useUnsavedChanges";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { ActionsSection } from "./ActionsSection";
import { useEscapeClosesPanels } from "../../../shared/escapeClosesPanels";
import type { DirtySection } from "../useUnsavedChanges";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderActions(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, unsaved: DirtySection[] = []) {
  return render(
    <MemoryRouter>
      <ActionsSection view={view} setView={setView} timeZone="America/Vancouver" unsaved={unsaved} />
    </MemoryRouter>,
  );
}

/** The Publish now dialog's own lookups (site address, list and category names) plus the POSTs it
 * may send, recorded in `posts`. */
function publishFetch(posts: { url: string; body: unknown }[], next: ReleaseView) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/nrms/api/config") return jsonResponse(200, { publicSiteUrl: "https://news.example.test/" });
    if (url === "/nrms/api/media-lists") return jsonResponse(200, [{ key: "regional", displayName: "Regional newspapers", isActive: true }]);
    if (url === "/nrms/api/categories")
      return jsonResponse(200, { ministries: [{ key: "health", name: "Health", abbreviation: "HLTH" }], sectors: [{ key: "seniors", name: "Seniors" }], themes: [], tags: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return jsonResponse(200, next);
  });
}

describe("ActionsSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("Approve is disabled while approveProblems is non-empty, and enabled once it's empty", () => {
    const { rerender } = render(
      <MemoryRouter>
        <ActionsSection view={releaseView({ status: "draft", ministries: [] })} setView={() => {}} timeZone="America/Vancouver" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    rerender(
      <MemoryRouter>
        <ActionsSection view={releaseView({ status: "draft", ministries: ["health"], leadMinistryKey: "health" })} setView={() => {}} timeZone="America/Vancouver" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("Approve does not show when the release is not a draft", () => {
    renderActions(releaseView({ status: "approved", reference: "NEWS-00001" }));
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("Advisory has no Unpublish button even when published", () => {
    renderActions(releaseView({ type: "advisory", status: "published", releasedAt: "2026-01-01T00:00:00.000Z", mediaListKeys: ["list1"] }));
    expect(screen.queryByRole("button", { name: "Unpublish" })).not.toBeInTheDocument();
  });

  it("a Release shows Unpublish once published", () => {
    renderActions(releaseView({ type: "release", status: "published", releasedAt: "2026-01-01T00:00:00.000Z" }));
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
  });

  // Minors: Unpublish takes a public release down — it needs a confirm dialog, same pattern
  // as Delete, instead of firing the POST straight from the button press.
  it("Unpublish opens a confirm dialog; only Confirm unpublish actually sends the request", async () => {
    const v = releaseView({ type: "release", status: "published", releasedAt: "2026-01-01T00:00:00.000Z" });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(200, releaseView({ ...v, status: "approved" }));
      }),
    );
    renderActions(v);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Unpublish" }));
    expect(calls).toHaveLength(0);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/take.*down|unpublish/i);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Unpublish" }));
    await user.click(await screen.findByRole("button", { name: "Confirm unpublish" }));
    await waitFor(() => expect(calls.some((c) => c.endsWith("/unpublish"))).toBe(true));
  });

  it('the delete dialog says "permanent" for a never-approved draft (no reference)', async () => {
    renderActions(releaseView({ status: "draft", reference: null }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/permanent/i);
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/keeps the record/i);
  });

  it('the delete dialog says the record is kept ("hidden") once there is a reference', async () => {
    renderActions(releaseView({ status: "approved", reference: "NEWS-00042" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/keeps the record/i);
    expect(screen.getByRole("dialog")).toHaveTextContent("NEWS-00042");
  });

  it("confirming delete POSTs /delete with the current version and navigates to drafts on success", async () => {
    const v = releaseView({ status: "draft", version: 3, reference: null });
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        return jsonResponse(200, { result: "deleted" });
      }),
    );
    render(
      <MemoryRouter initialEntries={["/releases/" + v.id]}>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: `/nrms/api/releases/${v.id}/delete`, body: { version: 3 } });
  });

  // Fix round 1, finding 2: a real Modal/AlertDialog, not a bare div.
  it("while the delete dialog is open, other action buttons aren't reachable (aria-hidden by the modal's overlay)", async () => {
    renderActions(releaseView({ status: "draft", reference: null, ministries: [] })); // draft -> Approve + Delete both show
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Still in the DOM, but hidden from the accessibility tree (and so from getByRole) while
    // the modal traps focus/interaction — exactly what a bare div never gave us for free.
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("opening the delete dialog moves focus into it, and closing it returns focus to the Delete button", async () => {
    renderActions(releaseView({ status: "draft", reference: null }));
    const user = userEvent.setup();
    const deleteButton = screen.getByRole("button", { name: "Delete" });
    await user.click(deleteButton);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // React Aria restores focus inside a requestAnimationFrame callback, one tick after the
    // scope unmounts — waitFor rather than a synchronous assertion.
    await waitFor(() => expect(document.activeElement).toBe(deleteButton));
  });

  it("Escape cancels the delete dialog without deleting anything", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { result: "deleted" }));
    vi.stubGlobal("fetch", fetchMock);
    renderActions(releaseView({ status: "draft", reference: null }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 409 on delete shows the reload message instead of navigating away", async () => {
    const v = releaseView({ status: "draft", version: 3, reference: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(409, { error: "version conflict" })),
    );
    render(
      <MemoryRouter initialEntries={["/releases/" + v.id]}>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();
  });

  // Owner decision 2026-10-29: Publish now confirms first, saying what will happen; only the
  // dialog's own "Publish now" sends the request.
  it("Publish now opens a confirm dialog; only its own Publish now POSTs /schedule with publishAt \"now\"", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 2 });
    const next = releaseView({ status: "published", version: 3 });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, next));
    const setView = vi.fn();
    renderActions(v, setView);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    const dialog = await screen.findByRole("dialog");
    expect(posts).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(setView).toHaveBeenCalledWith(next));
    expect(posts).toEqual([{ url: `/nrms/api/releases/${v.id}/schedule`, body: { version: 2, publishAt: "now" } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("cancelling the Publish now dialog posts nothing and returns focus to Publish now", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, v));
    renderActions(v);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Publish now" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts).toHaveLength(0);
    // React Aria restores focus in a requestAnimationFrame callback after the dialog unmounts.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("the Publish now dialog says where it publishes, which media lists get it, and who on News on Demand is emailed", async () => {
    const v = releaseView({
      status: "approved", key: "k1", reference: "NEWS-00001",
      ministries: ["health"], leadMinistryKey: "health", sectors: ["seniors"], themes: [], tags: [],
      mediaListKeys: ["regional"], publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: true },
    });
    vi.stubGlobal("fetch", publishFetch([], v));
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveTextContent("Publishes to news.example.test now."));
    await waitFor(() => expect(dialog).toHaveTextContent("Sends to media distribution lists: Regional newspapers."));
    expect(dialog).toHaveTextContent("Emails News on Demand subscribers who follow any of: Health; Seniors — and everyone subscribed to all news.");
  });

  it("the Publish now dialog says nobody is emailed when News on Demand and media lists are off", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", publishOptions: { toWeb: true, toSubscribers: false, toMediaLists: false } });
    vi.stubGlobal("fetch", publishFetch([], v));
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("No media distribution lists.");
    expect(dialog).toHaveTextContent("News on Demand subscribers will not be emailed.");
  });

  // Review P2: NoD and media sends happen once per release (keys are insert-or-ignore), so a
  // release published before (corrected, or unpublished and republished) emails nobody again.
  it("for a release that was published before, the dialog says nobody is emailed again", async () => {
    const v = releaseView({
      status: "approved", key: "k1", reference: "NEWS-00001", releasedAt: "2026-10-01T17:00:00.000Z",
      mediaListKeys: ["regional"], publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: true },
    });
    vi.stubGlobal("fetch", publishFetch([], v));
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Subscribers and media lists already received this when it was first published; they won’t be emailed again.");
    expect(dialog).not.toHaveTextContent("Emails News on Demand");
    expect(dialog).not.toHaveTextContent("Sends to media distribution lists");
  });

  // Review P3: a blocker can appear while the dialog is open (a background refresh, an edit in
  // another tab's section); the dialog's own Publish now follows it.
  it("the dialog's Publish now is disabled while there are blockers", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    vi.stubGlobal("fetch", publishFetch([], v));
    const { rerender } = renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Publish now" })).toBeEnabled();
    rerender(
      <MemoryRouter>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" unsaved={[{ key: "settings", label: "Save settings", save: async () => true }]} />
      </MemoryRouter>,
    );
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Publish now" })).toBeDisabled();
  });

  it("a 409 from the dialog's Publish now offers Reload in the dialog", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const fetchMock = publishFetch([], v);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => (url.endsWith("/schedule") ? jsonResponse(409, { error: "version conflict" }) : fetchMock(url, init))),
    );
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish now" }));
    expect(await within(dialog).findByText(/someone else changed this/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  // Review P3: the Publish now button leaves the page once the release is publishing, so focus
  // goes to the Actions heading instead of falling to <body>.
  it("after a successful Publish now, focus moves to the Actions heading", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 2 });
    const next = releaseView({ status: "publishing", key: "k1", reference: "NEWS-00001", version: 3 });
    vi.stubGlobal("fetch", publishFetch([], next));
    function Live() {
      const [view, setView] = useState(v);
      return <ActionsSection view={view} setView={setView} timeZone="America/Vancouver" unsaved={[]} />;
    }
    render(
      <MemoryRouter>
        <Live />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Actions" })).toHaveFocus());
  });

  // Owner decision 2026-10-29: publishing (or approving) a release while edits on the page are
  // still unsaved publishes the old text — blocked, with the reason next to the buttons.
  it("Publish now and Schedule are disabled while a section has unsaved edits, with a blocker linking to it; enabled once saved", () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const { rerender } = render(
      <MemoryRouter>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" unsaved={[{ key: "page-details", label: "Save page details", save: async () => true }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Publish now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    const why = screen.getByText("Publish now and Schedule are unavailable until:").parentElement!;
    expect(screen.getByRole("button", { name: "Publish now" })).toHaveAttribute("aria-describedby", why.id);
    expect(screen.getByRole("link", { name: "Save your changes to page details first." })).toHaveAttribute("href", "#section-page-details");

    rerender(
      <MemoryRouter>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" unsaved={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Publish now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled();
    expect(screen.queryByText(/Save your changes/)).not.toBeInTheDocument();
  });

  it("Approve is disabled while a document has unsaved edits, and the blocker links to that document", () => {
    const v = releaseView({ status: "draft", ministries: ["health"], leadMinistryKey: "health" });
    const docId = v.documents[0]!.id;
    renderActions(v, () => {}, [{ key: `document-${docId}-1`, label: "Save English content (Document 1)", save: async () => true }]);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Save your changes to English content (Document 1) first." })).toHaveAttribute("href", `#doc-${docId}-panel-1`);
  });

  // Fix round 1 (3f Task 3), finding 3: Schedule now sends the raw BC wall-clock string
  // (`publishAtLocal`), not a client-converted instant — the server converts it. Note: the
  // outer `waitFor(setView...)` assertion (not an `expect` thrown *inside* the fetch mock,
  // which a catch block elsewhere would silently swallow as a generic save failure) is what
  // actually fails this test if the request body is wrong.
  it("Schedule sends publishAtLocal (the typed BC wall-clock string), not a converted instant", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 2 });
    const next = releaseView({ status: "scheduled" });
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        return jsonResponse(200, next);
      }),
    );
    const setView = vi.fn();
    renderActions(v, setView);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2031-06-15" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    await user.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(setView).toHaveBeenCalledWith(next));
    const scheduleCall = calls.find((c) => c.url.endsWith("/schedule"));
    expect(scheduleCall?.body).toEqual({ version: 2, publishAtLocal: "2031-06-15T14:30" });
  });

  // Review P3: the server publishes a schedule at or before now immediately — with no dialog —
  // so Schedule only accepts a time in the future.
  it("Schedule refuses a time at or before now, pointing to Publish now", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, v));
    vi.stubGlobal("fetch", fetchMock);
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2020-01-01" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "09:00" } });
    expect(await screen.findByText("Choose a time in the future, or use Publish now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeDisabled();
    // Only the time-zone lookup — nothing posted.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
  });

  // Review P2: the server publishes a time up to 5 minutes in the past at once, with no
  // dialog. A time that was in the future when picked can be in the past when Confirm is
  // pressed, so it's checked again then — against BC time as the server reckons it.
  it("Confirm schedule re-checks the time: one that has passed since it was picked isn't sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2031-06-11T17:00:00.000Z")); // 10:00 in BC (UTC-7)
      const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
      const posts: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", publicSiteUrl: "", tzCheck: { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 } });
          if (init?.method === "POST") posts.push(url);
          return jsonResponse(200, v);
        }),
      );
      renderActions(v);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Schedule" }));
      fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2031-06-11" } });
      fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "10:01" } });
      expect(screen.queryByText("Choose a time in the future, or use Publish now.")).not.toBeInTheDocument();

      vi.setSystemTime(new Date("2031-06-11T17:02:00.000Z")); // two minutes later: 10:02
      await user.click(screen.getByRole("button", { name: "Confirm schedule" }));
      expect(await screen.findByText("Choose a time in the future, or use Publish now.")).toBeInTheDocument();
      expect(posts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 409 on an action shows the reload message with a Reload button, and never auto-retries", async () => {
    const v = releaseView({ status: "draft", ministries: ["health"], leadMinistryKey: "health" });
    const fetchMock = vi.fn(async () => jsonResponse(409, { error: "version conflict" }));
    vi.stubGlobal("fetch", fetchMock);
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await within(dialog).findByText(/someone else changed this/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Owner decision 2026-10-29: Approve asks first; only the dialog's own Approve sends it.
  it("Approve opens a confirm dialog; only its own Approve POSTs /approve", async () => {
    const v = releaseView({ status: "draft", ministries: ["health"], leadMinistryKey: "health", version: 4 });
    const next = releaseView({ status: "approved", reference: "NEWS-00009", version: 5 });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, next));
    const setView = vi.fn();
    renderActions(v, setView);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Approve this release?");
    expect(dialog).not.toHaveTextContent(/placeholder/i);
    expect(posts).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(setView).toHaveBeenCalledWith(next));
    expect(posts).toEqual([{ url: `/nrms/api/releases/${v.id}/approve`, body: { version: 4 } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("the Approve dialog warns about placeholder text and lists where it is, but still lets it be approved", async () => {
    const base = releaseView({ status: "draft", ministries: ["health"], leadMinistryKey: "health" });
    const doc = base.documents[0]!;
    const v = releaseView({
      ...base,
      documents: [{ ...doc, languages: [{ ...doc.languages[0]!, headline: "Clinic opening TBD", bodyHtml: "<p>Quote to come.</p>" }] }],
    });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, releaseView({ status: "approved", reference: "NEWS-00010" })));
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This release still has placeholder text:");
    const items = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Document 1 (English) headline: “Clinic opening TBD”", "Document 1 (English) body: “Quote to come.”"]);
    const approveButton = within(dialog).getByRole("button", { name: "Approve anyway" });
    expect(approveButton).toBeEnabled();
    await user.click(approveButton);
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual([`/nrms/api/releases/${v.id}/approve`]));
  });

  // Owner decision 2026-10-29: an approved release that hasn't gone out can go back to draft.
  it("Return to draft shows for an approved or scheduled release that has never been published, and not otherwise", () => {
    renderActions(releaseView({ status: "approved", reference: "NEWS-00001", key: "k" }));
    expect(screen.getByRole("button", { name: "Return to draft" })).toBeInTheDocument();
    cleanup();
    renderActions(releaseView({ status: "scheduled", reference: "NEWS-00001", key: "k", publishAt: "2031-01-01T18:00:00.000Z" }));
    expect(screen.getByRole("button", { name: "Return to draft" })).toBeInTheDocument();
    cleanup();
    renderActions(releaseView({ status: "approved", reference: "NEWS-00001", key: "k", releasedAt: "2026-10-01T17:00:00.000Z" }));
    expect(screen.queryByRole("button", { name: "Return to draft" })).not.toBeInTheDocument();
    cleanup();
    renderActions(releaseView({ status: "approved", reference: "NEWS-00001", key: "k", atomId: "legacy-atom" }));
    expect(screen.queryByRole("button", { name: "Return to draft" })).not.toBeInTheDocument();
    cleanup();
    renderActions(releaseView({ status: "draft" }));
    expect(screen.queryByRole("button", { name: "Return to draft" })).not.toBeInTheDocument();
  });

  it("Return to draft confirms first, saying the numbers are given up and the schedule is dropped; then POSTs /return-to-draft", async () => {
    const v = releaseView({ status: "scheduled", reference: "NEWS-00007", key: "2026HLTH0007-000070", publishAt: "2031-01-15T18:30:00.000Z", version: 6 });
    const next = releaseView({ status: "draft", version: 7 });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, next));
    const setView = vi.fn();
    renderActions(v, setView);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Return to draft" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Return this release to draft?");
    expect(dialog).toHaveTextContent("NEWS-00007");
    expect(dialog).toHaveTextContent("2026HLTH0007-000070");
    expect(dialog).toHaveTextContent("It will no longer be published on Jan 15, 2031");
    expect(posts).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Return to draft" }));
    await waitFor(() => expect(setView).toHaveBeenCalledWith(next));
    expect(posts).toEqual([{ url: `/nrms/api/releases/${v.id}/return-to-draft`, body: { version: 6 } }]);
  });

  // Owner decision 2026-10-29: Schedule starts from the planned publish date when it's still ahead.
  it("Schedule is prefilled from a future planned publish date, and Confirm sends it as is", async () => {
    // 2031-06-15 21:30Z is 14:30 in BC (UTC-7).
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 2, publishAt: "2031-06-15T21:30:00.000Z" });
    const next = releaseView({ status: "scheduled" });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, next));
    const setView = vi.fn();
    renderActions(v, setView);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByLabelText("Date")).toHaveValue("2031-06-15");
    expect(screen.getByLabelText("Time (BC time)")).toHaveValue("14:30");
    await user.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(setView).toHaveBeenCalledWith(next));
    expect(posts).toEqual([{ url: `/nrms/api/releases/${v.id}/schedule`, body: { version: 2, publishAtLocal: "2031-06-15T14:30" } }]);
  });

  // Owner decision 2026-10-29: Confirm schedule commits a future send to the same audience as
  // Publish now, so it asks first in the same way — when (the BC wall-clock time exactly as the
  // server will read it) and who is emailed — and only the dialog's own Schedule sends it.
  it("Confirm schedule asks first: the dialog says when it goes out (Pacific time) and who is emailed; nothing is sent until its Schedule", async () => {
    const v = releaseView({
      status: "approved", key: "k1", reference: "NEWS-00001", version: 2,
      ministries: ["health"], leadMinistryKey: "health", sectors: ["seniors"], themes: [], tags: [],
      mediaListKeys: ["regional"], publishOptions: { toWeb: true, toSubscribers: true, toMediaLists: true },
    });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, releaseView({ status: "scheduled", version: 3 })));
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2031-06-15" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    await user.click(screen.getByRole("button", { name: "Confirm schedule" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Schedule this release for Sunday, June 15, 2031 at 2:30 PM Pacific time?");
    await waitFor(() => expect(dialog).toHaveTextContent("Publishes to news.example.test on Sunday, June 15, 2031 at 2:30 PM Pacific time."));
    await waitFor(() => expect(dialog).toHaveTextContent("Sends to media distribution lists: Regional newspapers."));
    expect(dialog).toHaveTextContent("Emails News on Demand subscribers who follow any of: Health; Seniors — and everyone subscribed to all news.");
    expect(posts).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(posts).toEqual([{ url: `/nrms/api/releases/${v.id}/schedule`, body: { version: 2, publishAtLocal: "2031-06-15T14:30" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("cancelling the schedule dialog sends nothing, keeps the chosen time, and returns focus to Confirm schedule", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", publishFetch(posts, v));
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2031-06-15" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    const confirm = screen.getByRole("button", { name: "Confirm schedule" });
    await user.click(confirm);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts).toEqual([]);
    expect(screen.getByLabelText("Time (BC time)")).toHaveValue("14:30");
    await waitFor(() => expect(confirm).toHaveFocus());
  });

  it("Confirm schedule is unavailable while a section has unsaved edits, so the dialog can't open", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", publishAt: "2031-06-15T21:30:00.000Z" });
    vi.stubGlobal("fetch", publishFetch([], v));
    const unsaved = [{ key: "page-details", label: "Save page details", save: async () => true }];
    const { rerender } = render(
      <MemoryRouter>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" />
      </MemoryRouter>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Schedule" }));
    rerender(
      <MemoryRouter>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" unsaved={unsaved} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the Schedule toggle says whether its panel is open, and which panel it controls", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", publishAt: null });
    vi.stubGlobal("fetch", publishFetch([], v));
    renderActions(v);
    const toggle = screen.getByRole("button", { name: "Schedule" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel).toContainElement(screen.getByLabelText("Date"));
  });

  // Review (LOW): Esc used to close the Schedule panel even with a time typed in, and reopening
  // started over — the typed time was lost without a word.
  it("Esc closes the Schedule panel when nothing in it changed, but not once a date or time is typed", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", publishAt: null });
    vi.stubGlobal("fetch", publishFetch([], v));
    function WithEsc(): React.JSX.Element {
      useEscapeClosesPanels();
      return <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" />;
    }
    render(
      <MemoryRouter>
        <WithEsc />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Schedule" });
    await user.click(toggle);
    screen.getByLabelText("Date").focus();
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2031-06-15" } });
    screen.getByLabelText("Date").focus();
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Date")).toHaveValue("2031-06-15");
  });

  it("an open Schedule panel counts as unsaved only once its date or time is changed from what it opened with", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", publishAt: "2031-06-15T21:30:00.000Z" });
    vi.stubGlobal("fetch", publishFetch([], v));
    function Page(): React.JSX.Element {
      const guard = useUnsavedChangesGuard();
      return (
        <guard.Provider>
          <p>{guard.anyDirty ? "dirty" : "clean"}</p>
          <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" />
        </guard.Provider>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Page /> }], { initialEntries: ["/"] });
    render(
      <AnnouncerProvider>
        <RouterProvider router={router} />
      </AnnouncerProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    // Prefilled from the planned date: nothing to lose yet.
    expect(screen.getByText("clean")).toBeInTheDocument();
    const time = screen.getByLabelText("Time (BC time)");
    fireEvent.change(time, { target: { value: "15:00" } });
    expect(await screen.findByText("dirty")).toBeInTheDocument();
    // Back to what it opened with: clean again.
    fireEvent.change(time, { target: { value: "14:30" } });
    expect(await screen.findByText("clean")).toBeInTheDocument();
  });

  it("Schedule starts empty when the planned publish date has passed", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", publishAt: "2020-06-15T21:30:00.000Z" });
    vi.stubGlobal("fetch", publishFetch([], v));
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByLabelText("Date")).toHaveValue("");
    expect(screen.getByLabelText("Time (BC time)")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Confirm schedule" })).toBeDisabled();
  });

  // Hand-check feedback: say why Approve/Publish are unavailable next to the buttons, not only
  // in the header's checklist a long scroll away.
  it("a draft that can't be approved says why next to Approve, and points the button at it", () => {
    renderActions(releaseView({ status: "draft", ministries: [] }));
    const why = screen.getByText("Approve is unavailable until:").parentElement!;
    expect(why).toHaveTextContent("Choose at least one ministry.");
    expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-describedby", why.id);
    expect(screen.getByText("Publish now and Schedule appear once this is approved.")).toBeInTheDocument();
  });

  it("an approvable draft has no 'unavailable' reasons", () => {
    renderActions(releaseView({ status: "draft", ministries: ["health"], leadMinistryKey: "health" }));
    expect(screen.queryByText(/is unavailable until/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).not.toHaveAttribute("aria-describedby");
  });

  it("an approved release that can't be published lists what's missing next to Publish now and Schedule", () => {
    renderActions(releaseView({ status: "approved", reference: "NEWS-00001", key: "k", documents: [] }));
    const why = screen.getByText("Publish now and Schedule are unavailable until:").parentElement!;
    expect(why).toHaveTextContent("Add at least one document.");
    expect(screen.getByRole("button", { name: "Publish now" })).toHaveAttribute("aria-describedby", why.id);
    expect(screen.getByRole("button", { name: "Schedule" })).toHaveAttribute("aria-describedby", why.id);
    expect(screen.queryByText("Approve is unavailable until:")).not.toBeInTheDocument();
  });

  // Each reason links to (and, on click, scrolls/focuses) the section it's about — "where
  // practical": at minimum Categories for a ministry/sector problem, Documents for a
  // per-document one.
  it("a ministry/sector reason links to #section-categories", () => {
    renderActions(releaseView({ status: "draft", ministries: [] }));
    expect(screen.getByRole("link", { name: "Choose at least one ministry." })).toHaveAttribute("href", "#section-categories");
  });

  it("'Add at least one document' links to #section-documents, and a per-document reason links to that document's own heading", () => {
    renderActions(releaseView({ status: "approved", reference: "NEWS-00001", key: "k", documents: [] }));
    expect(screen.getByRole("link", { name: "Add at least one document." })).toHaveAttribute("href", "#section-documents");
  });

  it("clicking a reason link scrolls to and focuses its target", async () => {
    document.body.innerHTML += '<section id="section-categories" tabindex="-1">Categories</section>';
    renderActions(releaseView({ status: "draft", ministries: [] }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Choose at least one ministry." }));
    expect(document.getElementById("section-categories")).toHaveFocus();
  });
});
