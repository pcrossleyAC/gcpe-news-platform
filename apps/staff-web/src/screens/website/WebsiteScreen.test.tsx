import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SiteSettingsIndex, WebsiteScreen } from "./WebsiteScreen";

function renderWithRole(role: string, at = "/website") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: [role] }, expiresAt: new Date().toISOString() });
      return jsonResponse(200, {});
    }),
  );
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[at]}>
        <RequireAuth>
          <Routes>
            <Route path="/website" element={<WebsiteScreen />}>
              <Route index element={<p>index child</p>} />
              <Route path="settings" element={<SiteSettingsIndex />} />
              <Route path="banner" element={<p>banner child</p>} />
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

  it("shows the daily tabs, then Site settings, and the outlet to NRMS.SiteEditor", async () => {
    renderWithRole("NRMS.SiteEditor");
    await screen.findByRole("link", { name: "Carousel" });
    const tabs = within(screen.getByRole("navigation", { name: "Website sections" })).getAllByRole("link").map((l) => l.textContent);
    expect(tabs).toEqual(["Carousel", "Emergency pins", "Live Feed", "What's featured where", "Resource links", "Files", "Hub address check", "Website log", "Site settings"]);
    expect(screen.getByRole("link", { name: "Site settings" })).toHaveAttribute("href", "/website/settings");
    expect(screen.queryByRole("navigation", { name: "Site settings pages" })).toBeNull();
    expect(screen.getByText("index child")).toBeInTheDocument();
  });

  it("Site settings lists every settings page with a line on each, and Project Blue Bridge under Restricted", async () => {
    renderWithRole("NRMS.SiteEditor", "/website/settings");
    await screen.findByRole("heading", { name: "Site settings", level: 1 });
    expect(screen.getByRole("link", { name: "Site settings" })).toHaveAttribute("aria-current", "page");
    const main = screen.getByRole("heading", { name: "Site settings", level: 1 }).parentElement!;
    const labels = within(main).getAllByRole("link").map((l) => l.textContent);
    expect(labels).toEqual(["Site banner", "Footer links", "Social links", "Theme colours", "Ministry page headings", "Media contacts page", "Page text", "Navigation and labels", "Site identity", "Settings history", "Project Blue Bridge"]);
    expect(within(main).getByRole("link", { name: "Site banner" })).toHaveAttribute("href", "/website/banner");
    expect(within(main).getByRole("link", { name: "Settings history" })).toHaveAttribute("href", "/website/settings-history");
    expect(within(main).getByRole("link", { name: "Project Blue Bridge" })).toHaveAttribute("href", "/website/blue-bridge");
    expect(screen.getByRole("heading", { name: "Restricted", level: 2 })).toBeInTheDocument();
  });

  it("on a settings page, Site settings is the current tab and a second row moves between settings pages", async () => {
    renderWithRole("NRMS.SiteEditor", "/website/banner");
    await screen.findByText("banner child");
    expect(screen.getByRole("link", { name: "Site settings" })).toHaveAttribute("aria-current", "true");
    const pages = screen.getByRole("navigation", { name: "Site settings pages" });
    expect(within(pages).getByRole("link", { name: "Site banner" })).toHaveAttribute("aria-current", "page");
    expect(within(pages).getByRole("link", { name: "All site settings" })).toHaveAttribute("href", "/website/settings");
    expect(within(pages).getByRole("link", { name: "Ministry page headings" })).toHaveAttribute("href", "/website/ministry-pages");
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
    expect(screen.queryByRole("link", { name: "Site banner" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Site settings" })).toBeNull();
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
