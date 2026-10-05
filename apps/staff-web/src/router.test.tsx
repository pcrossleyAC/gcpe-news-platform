import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionProvider } from "./session/SessionContext";
import { routes } from "./router";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fix round 1 (minor): a router-level test against the real route table (not a screen in
 * isolation), with the real basename, covering the two things the brief calls out by name. */
describe("router (basename /hub)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("/ redirects to /hub/releases/drafts, and a row link resolves to /hub/releases/<id>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") {
          return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        }
        if (url.startsWith("/nrms/api/releases")) {
          return jsonResponse(200, {
            items: [
              {
                id: "22222222-2222-2222-2222-222222222222",
                type: "release",
                key: null,
                reference: null,
                status: "draft",
                statusText: "Draft",
                leadOrganization: "Education",
                pageTitle: "A page title",
                headline: "A headline",
                location: "VICTORIA",
                summary: "A summary.",
                publishAt: null,
                releasedAt: null,
                activityId: null,
                approved: false,
                flickrAlert: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    // The same `routes` + basename createAppRouter uses, just via createMemoryRouter so the
    // test controls the starting entry instead of touching the real browser location/history.
    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub"] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/hub/releases/drafts"));

    // The basename is prefixed onto every rendered href too, including a row's link.
    const link = await screen.findByRole("link", { name: "A headline" });
    expect(link).toHaveAttribute("href", "/hub/releases/22222222-2222-2222-2222-222222222222");
  });
});
