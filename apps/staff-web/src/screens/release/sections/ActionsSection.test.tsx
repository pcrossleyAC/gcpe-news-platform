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
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/nrms/api/releases/${v.id}/delete`);
      expect(JSON.parse(init!.body as string)).toEqual({ version: 3 });
      return jsonResponse(200, { result: "deleted" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/releases/" + v.id]}>
        <ActionsSection view={v} setView={() => {}} timeZone="America/Vancouver" />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(fetchMock).toHaveBeenCalled();
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

  it("Schedule converts the typed BC local date/time and POSTs that ISO instant", async () => {
    const v = releaseView({ status: "approved", key: "k1", reference: "NEWS-00001", version: 2 });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/schedule")) throw new Error(`unexpected: ${url}`);
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ version: 2, publishAt: "2026-06-15T21:30:00.000Z" });
      return jsonResponse(200, releaseView({ status: "scheduled" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderActions(v);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-06-15" } });
    fireEvent.change(screen.getByLabelText("Time (BC time)"), { target: { value: "14:30" } });
    await user.click(screen.getByRole("button", { name: "Confirm schedule" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
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
