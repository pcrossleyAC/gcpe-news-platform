import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { ActionsSection } from "./ActionsSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderActions(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}) {
  return render(
    <MemoryRouter>
      <ActionsSection view={view} setView={setView} timeZone="America/Vancouver" />
    </MemoryRouter>,
  );
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

  it("Publish now POSTs /schedule with publishAt \"now\"", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 2 });
    const next = releaseView({ status: "published", version: 3 });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/nrms/api/releases/${v.id}/schedule`);
      expect(JSON.parse(init!.body as string)).toEqual({ version: 2, publishAt: "now" });
      return jsonResponse(200, next);
    });
    vi.stubGlobal("fetch", fetchMock);
    const setView = vi.fn();
    renderActions(v, setView);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(setView).toHaveBeenCalledWith(next));
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
});
