import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { jsonResponse } from "../test/jsonResponse";
import { SessionProvider } from "./session/SessionContext";
import { routes } from "./router";

// Suite review H3: a screen that crashes. Search stands in for any screen in the shell.
vi.mock("./screens/search/SearchScreen", () => ({
  SearchScreen: () => {
    throw new Error("Crashed while showing the screen");
  },
}));

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
      if (url === "/core/api/time-zone-check") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url.startsWith("/nrms/api/releases")) return jsonResponse(200, { items: [], total: 0, page: 1, pageSize: 25 });
      return jsonResponse(404, { error: "not found" });
    }),
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: [path] });
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

describe("the Hub's error and not-found pages, inside the shell", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("H3: a screen that crashes shows a plain message with Reload and a way to the start page, and the menu stays", async () => {
    stub();
    const onError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = renderAt("/hub/search");
      expect(await screen.findByRole("heading", { level: 1, name: "Something went wrong" })).toBeInTheDocument();
      expect(screen.getByText("This page couldn’t be shown. Reload the page to try again.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
      expect(screen.queryByText("Crashed while showing the screen")).toBeNull();
      // The shell is still there.
      expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();

      await userEvent.setup().click(screen.getByRole("link", { name: "Go to the start page" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/hub/releases/drafts"));
      expect(await screen.findByText("No releases.")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Something went wrong" })).toBeNull();
    } finally {
      onError.mockRestore();
    }
  });

  it("H4: an unknown address shows Page not found with a link to the start page", async () => {
    stub();
    const router = renderAt("/hub/no-such-screen");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("There’s no page at this address. The link may be out of date, or the address may have been typed wrong.")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("link", { name: "Go to the start page" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/hub/releases/drafts"));
  });

  it("H4: an unknown address deeper inside a section shows Page not found too", async () => {
    stub();
    renderAt("/hub/releases/drafts/extra");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});
