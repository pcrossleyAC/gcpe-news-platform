import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscribersSection } from "./SubscribersSection";

function renderAs(roles: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    return jsonResponse(200, {});
  }));
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers" element={<SubscribersSection />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

const links = async () => within(await screen.findByRole("navigation", { name: "Subscribers sections" })).getAllByRole("link").map((l) => l.textContent);

describe("SubscribersSection nav", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });
  it("Viewer", async () => {
    renderAs(["NoD.Viewer"]);
    expect(await links()).toEqual(["Find subscribers", "Lists and categories", "Media lists"]);
  });
  it("Editor", async () => {
    renderAs(["NoD.Editor"]);
    expect(await links()).toEqual(["Find subscribers", "Add a subscriber", "Lists and categories", "Media lists"]);
  });
  it("Admin", async () => {
    renderAs(["NoD.Admin"]);
    expect(await links()).toEqual(["Find subscribers", "Add a subscriber", "Lists and categories", "Media lists", "Operations"]);
  });
});
