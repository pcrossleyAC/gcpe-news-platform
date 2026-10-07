import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { MediaListsScreen } from "./MediaListsScreen";

const LISTS = [
  { listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 12, needsAttention: 2 },
  { listKey: "media-distribution-lists:old", key: "old", name: "Old list", active: false, members: 0, needsAttention: 0 },
];
const SYNC = { since: null, at: "2026-10-07T09:00:00.000Z", result: { contacts: 5, updated: 1, flagged: 1, removed: 0, errors: 0 }, running: false };

function stub(
  roles: string[],
  syncPost: () => Response = () => jsonResponse(200, { done: true, result: { contacts: 1, updated: 0, flagged: 0, removed: 0, errors: 0 } }),
  lists: () => Response = () => jsonResponse(200, LISTS),
) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/media-lists") return lists();
    if (url === "/nod/api/media-hub/sync") return init?.method === "POST" ? syncPost() : jsonResponse(200, SYNC);
    throw new Error(`unhandled: ${url}`);
  }));
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/media-lists"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/media-lists" element={<MediaListsScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("MediaListsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists media lists with members and attention counts and the last sync; a Viewer can't run it", async () => {
    stub(["NoD.Viewer"]);
    renderIt();
    expect(await screen.findByRole("link", { name: "Budget" })).toHaveAttribute("href", "/subscribers/media-lists/budget");
    expect(screen.getByRole("row", { name: /Budget 12 2 Active/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Old list 0 0 Retired/ })).toBeInTheDocument();
    expect(screen.getByText("5 changed contacts: 1 updated, 1 flagged, 0 removed, 0 skipped.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync with Media Hub now" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage media list names" })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Media lists — GCPE News Staff"));
  });

  it("an Editor runs the sync; a sync already running is explained", async () => {
    stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sync with Media Hub now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sync finished.");
    cleanup();
    vi.unstubAllGlobals();
    stub(["NoD.Editor"], () => jsonResponse(409, { error: "sync in progress" }));
    renderIt();
    await user.click(await screen.findByRole("button", { name: "Sync with Media Hub now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A sync is already running.");
  });

  it("a Core Admin with a NoD role gets the names link", async () => {
    stub(["NoD.Viewer", "Core.Admin"]);
    renderIt();
    expect(await screen.findByRole("link", { name: "Manage media list names" })).toHaveAttribute("href", "/media-list-names");
  });

  it("a failed load says so instead of loading forever", async () => {
    stub(["NoD.Viewer"], undefined, () => jsonResponse(500, { error: "boom" }));
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load media lists.");
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
