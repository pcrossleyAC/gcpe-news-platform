import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { SettingsSection } from "./SettingsSection";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(handlers: { mediaLists?: unknown; onPut?: (url: string, body: unknown) => Response } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url === "/nrms/api/media-lists") return jsonResponse(200, handlers.mediaLists ?? []);
      if (handlers.onPut) return handlers.onPut(url, body);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function renderSettings(view: ReleaseView, setView: (v: ReleaseView) => void = () => {}, readOnly = false) {
  return render(<SettingsSection view={view} setView={setView} timeZone="America/Vancouver" readOnly={readOnly} />);
}

describe("SettingsSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("reflects the release's current toSubscribers and mediaListKeys", async () => {
    stubFetch({ mediaLists: [{ id: "m1", key: "list1", name: "List One" }] });
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
      mediaLists: [{ id: "m1", key: "list1", name: "List One" }],
      onPut: () => jsonResponse(200, saved),
    });
    const v = releaseView({ type: "release", version: 1, mediaListKeys: [] });
    const setView = vi.fn();
    renderSettings(v, setView);
    await screen.findByLabelText("List One");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("List One"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

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
    await user.click(screen.getByRole("button", { name: "Save settings" }));

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
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/settings"))).toBe(true));
    const put = calls.find((c) => c.url === `/nrms/api/releases/${v.id}/settings`);
    expect(put?.body).toMatchObject({ version: 1, plannedPublishAt: null });
    expect(put?.body).not.toHaveProperty("plannedPublishAtLocal");
  });

  it("read-only disables every control and hides the Save button", async () => {
    stubFetch({ mediaLists: [{ id: "m1", key: "list1", name: "List One" }] });
    renderSettings(releaseView({ type: "release" }), () => {}, true);
    expect(await screen.findByLabelText("List One")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/someone else changed this/i)).toBeInTheDocument();

    // The user's edit is still showing, untouched — never silently reverted or retried.
    expect(screen.getByLabelText("Send to News On Demand subscribers")).not.toBeChecked();
    expect(putCount).toBe(1);
    void calls;
  });
});
