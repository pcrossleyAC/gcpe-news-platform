import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { AddressCheckScreen } from "./AddressCheckScreen";
import type { InternalLink } from "./types";

const LINKS: InternalLink[] = [
  { screen: "carousel", where: "Live carousel, slide 2: action URL", address: "https://gcpe-app01.internal/files/minister.jpg" },
  { screen: "carousel", where: "Next carousel, slide 1: Facebook post URL", address: "https://hub.example/fb" },
  { screen: "links", where: "Link 2 URL", address: "https://hub.example/files/r.pdf" },
  { screen: "settings", section: "footer", where: "Link “Contact us”", address: "https://hub.example/contact" },
  { screen: "settings", section: "pageText", where: "", address: "https://hub.example/files/help.pdf" },
];

function renderAs(role: string, links: InternalLink[] | "fail" = LINKS) {
  const fetch = vi.fn(async (url: string) => {
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: [role] }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/site/internal-links") return links === "fail" ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, { links });
    throw new Error(`unhandled: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <AddressCheckScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
  return fetch;
}

describe("AddressCheckScreen (suite fix W2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists each saved address that points at the Hub under the screen that edits it, with Open to that screen", async () => {
    renderAs("NRMS.SiteEditor");
    await screen.findByRole("heading", { name: "Hub address check", level: 1 });
    await waitFor(() => expect(document.title).toBe("Hub address check — GCPE News Staff"));
    const groups = await screen.findAllByRole("heading", { level: 2 });
    expect(groups.map((h) => h.textContent)).toEqual(["Carousel", "Resource links", "Footer links", "Page text"]);

    const carousel = screen.getByRole("region", { name: "Carousel" });
    expect(within(carousel).getByRole("link", { name: "Open Carousel" })).toHaveAttribute("href", "/website/carousel");
    const items = within(carousel).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Live carousel, slide 2: action URL: https://gcpe-app01.internal/files/minister.jpg", "Next carousel, slide 1: Facebook post URL: https://hub.example/fb"]);

    expect(within(screen.getByRole("region", { name: "Footer links" })).getByRole("link", { name: "Open Footer links" })).toHaveAttribute("href", "/website/footer");
    expect(within(screen.getByRole("region", { name: "Page text" })).getByRole("listitem")).toHaveTextContent(/^https:\/\/hub\.example\/files\/help\.pdf$/);
    expect(screen.getByText("5 saved addresses point at the Hub.")).toBeInTheDocument();
    // Read-only: nothing here changes anything.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says so when nothing points at the Hub", async () => {
    renderAs("Core.Admin", []);
    await screen.findByText("Nothing saved on the Website points at the Hub.");
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
  });

  it("shows an error when the check can't be loaded", async () => {
    renderAs("NRMS.SiteEditor", "fail");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check the saved addresses. Reload the page to try again.");
  });

  it("a release editor sees no list and nothing is asked of the server", async () => {
    const fetch = renderAs("NRMS.Editor");
    await screen.findByText("You don’t have permission to view the Hub address check.");
    expect(fetch.mock.calls.map(([u]) => u)).not.toContain("/nrms/api/site/internal-links");
  });
});
