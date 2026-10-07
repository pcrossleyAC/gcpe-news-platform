import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

  // Minors: every read role (Viewer, Editor, SiteEditor, Core.Admin) can now reach Website at
  // all, for Featured/the log — only a role with none of those four (out of scope per
  // constraints.md — NoD.Admin/Distribution.Send) is blocked entirely.
  it("a Viewer sees the sub-nav too, but only Featured/the log (not the manage-only sections)", async () => {
    renderWithRole("NRMS.Viewer");
    await screen.findByRole("link", { name: "What's featured where" });
    expect(screen.getByRole("link", { name: "Website log" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Carousel" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Project Blue Bridge" })).toBeNull();
    expect(screen.getByText("index child")).toBeInTheDocument();
  });

  it("blocks a role with none of Viewer/Editor/SiteEditor/Core.Admin", async () => {
    renderWithRole("NoD.Admin");
    await screen.findByText("You don’t have permission to view the Website section.");
    expect(screen.queryByRole("link", { name: "What's featured where" })).toBeNull();
  });

  // I5: document.title matches the permission-denied branch's own h1.
  it("sets the document title on the permission-denied branch", async () => {
    renderWithRole("NoD.Admin");
    await screen.findByRole("heading", { name: "Website", level: 1 });
    await waitFor(() => expect(document.title).toBe("Website — GCPE News Staff"));
  });
});
