import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { MediaListNamesScreen } from "./MediaListNamesScreen";

const ROWS = [
  { key: "001-a-daily-news", displayName: "Daily news", sortOrder: 1, isActive: true },
  { key: "002-budget", displayName: "Budget", sortOrder: 2, isActive: true },
];
type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], onPost?: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nrms/api/media-lists" && method === "GET") return jsonResponse(200, ROWS);
    if (url === "/nrms/api/media-lists" && method === "POST") return onPost?.() ?? jsonResponse(201, { key: "003-new", displayName: "New", sortOrder: 0, isActive: true });
    if (url.startsWith("/nrms/api/media-lists/") && method === "PUT") return jsonResponse(200, {});
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/media-list-names"]}>
        <RequireAuth>
          <Routes>
            <Route path="/media-list-names" element={<MediaListNamesScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("MediaListNamesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("refuses anyone but a Core Admin", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    expect(await screen.findByText("You don’t have permission to manage media list names.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/nrms/api/media-lists")).toBe(false);
    await waitFor(() => expect(document.title).toBe("Media list names — GCPE News Staff"));
  });

  it("renames a list and adds one; a duplicate key is explained", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "Name for 002-budget" });
    await user.clear(name);
    await user.type(name, "Budget 2027");
    await user.click(screen.getByRole("button", { name: "Save 002-budget" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nrms/api/media-lists/002-budget", method: "PUT", body: { displayName: "Budget 2027", sortOrder: 2, isActive: true } }));
    await user.type(screen.getByRole("textbox", { name: "Key" }), "003-new");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "New");
    await user.click(screen.getByRole("button", { name: "Add media list" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nrms/api/media-lists", method: "POST", body: { key: "003-new", displayName: "New" } }));
  });

  it("retiring a list asks first", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "002-budget active" }));
    await user.click(screen.getByRole("button", { name: "Save 002-budget" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Retire list" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nrms/api/media-lists/002-budget", method: "PUT", body: { displayName: "Budget", sortOrder: 2, isActive: false } }));
  });
});
