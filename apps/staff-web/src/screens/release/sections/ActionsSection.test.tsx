import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { ActionsSection } from "./ActionsSection";
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

  // Owner decision 2026-10-29: publishing (or approving) a release while edits on the page are
  // still unsaved publishes the old text — blocked, with the reason next to the buttons.
  it("Publish now and Schedule are disabled while a section has unsaved edits, with a blocker linking to it; enabled once saved", () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001" });
    const { rerender } = render(
      <MemoryRouter>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" unsaved={[{ key: "page-details", label: "Save page details", save: () => {} }]} />
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
    renderActions(v, () => {}, [{ key: `document-${docId}-1`, label: "Save English content (Document 1)", save: () => {} }]);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Save your changes to English content (Document 1) first." })).toHaveAttribute("href", "#document-1-heading");
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
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    await user.click(screen.getByRole("button", { name: "Confirm schedule" }));

    await waitFor(() => expect(setView).toHaveBeenCalledWith(next));
    const scheduleCall = calls.find((c) => c.url.endsWith("/schedule"));
    expect(scheduleCall?.body).toEqual({ version: 2, publishAtLocal: "2026-06-15T14:30" });
  });

  it("a 409 on an action shows the reload message with a Reload button, and never auto-retries", async () => {
    const v = releaseView({ status: "draft", ministries: ["health"], leadMinistryKey: "health" });
    const fetchMock = vi.fn(async () => jsonResponse(409, { error: "version conflict" }));
    vi.stubGlobal("fetch", fetchMock);
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
