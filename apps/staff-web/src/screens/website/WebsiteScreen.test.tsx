import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { WebsiteScreen } from "./WebsiteScreen";

function renderWithRole(role: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: [role] }, expiresAt: new Date().toISOString() });
      return jsonResponse(200, {});
    }),
  );
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/website"]}>
        <RequireAuth>
          <Routes>
            <Route path="/website" element={<WebsiteScreen />}>
              <Route index element={<p>index child</p>} />
            </Route>
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("WebsiteScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the sub-nav and outlet to NRMS.SiteEditor", async () => {
    renderWithRole("NRMS.SiteEditor");
    await screen.findByRole("link", { name: "Carousel" });
    expect(screen.getByRole("link", { name: "Project Blue Bridge" })).toBeInTheDocument();
    expect(screen.getByText("index child")).toBeInTheDocument();
  });

  it("shows the sub-nav to Core.Admin too", async () => {
    renderWithRole("Core.Admin");
    await screen.findByRole("link", { name: "Carousel" });
  });

  it("blocks a role with neither NRMS.SiteEditor nor Core.Admin", async () => {
    renderWithRole("NRMS.Viewer");
    await screen.findByText("You don’t have permission to view the Website section.");
    expect(screen.queryByRole("link", { name: "Carousel" })).toBeNull();
  });
});
