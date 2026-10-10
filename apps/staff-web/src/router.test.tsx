import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
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

  it("/hub/releases/new renders the New release screen, and /hub/releases/:id renders the real editor (Task 3), not a placeholder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Editor"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") {
          return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        }
        if (url === "/nrms/api/page-types" || url === "/nrms/api/page-images" || url === "/nrms/api/media-lists") return jsonResponse(200, []);
        if (url === "/nrms/api/categories") return jsonResponse(200, { ministries: [], sectors: [], themes: [], tags: [] });
        if (url.endsWith("/asset-status")) return jsonResponse(200, { kind: "none" });
        if (url === "/nrms/api/releases/33333333-3333-3333-3333-333333333333") {
          return jsonResponse(200, releaseView({ id: "33333333-3333-3333-3333-333333333333" }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub/releases/new"] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "New release" })).toBeInTheDocument();

    router.navigate("/releases/33333333-3333-3333-3333-333333333333");
    expect(await screen.findByRole("heading", { name: "Actions" })).toBeInTheDocument();
    expect(screen.queryByText(/editor isn.t built yet/i)).not.toBeInTheDocument();
  });

  it("/hub/website, /hub/users and /hub/error-log render Task 5's real screens for Core.Admin, not placeholders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") {
          return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: false });
        }
        if (url === "/nrms/api/site/carousels") return jsonResponse(200, { live: null, next: null, past: [] });
        if (url === "/core/api/users") return jsonResponse(200, []);
        if (url === "/stack/errors?limit=200") return jsonResponse(200, { errors: [] });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub/website"] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Carousel" })).toBeInTheDocument();

    router.navigate("/users");
    expect(await screen.findByRole("heading", { level: 1, name: "Users" })).toBeInTheDocument();

    router.navigate("/error-log");
    expect(await screen.findByRole("heading", { level: 1, name: "Error log" })).toBeInTheDocument();
  });

  // Decided after the plan was written: search is a POST to /nod/api/subscribers/search, never
  // a GET with the term in the query string.
  it("a NoD-only user lands on Subscribers; /hub/subscribers/new is the Add screen for an Editor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NoD.Editor"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/nod/api/subscribers/search") return jsonResponse(200, { total: 0, page: 1, pageSize: 50, items: [] });
        if (url === "/nod/api/subscriber-list-options") return jsonResponse(200, { categories: [] });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub/"] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Subscribers" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/hub/subscribers");
    router.navigate("/subscribers/new");
    expect(await screen.findByRole("heading", { level: 1, name: "Add a subscriber" })).toBeInTheDocument();
  });

  it("a Calendar administrator with no NRMS or NoD role lands on Calendar access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/core/api/calendar-access") return jsonResponse(200, []);
        if (url === "/core/api/organizations") return jsonResponse(200, []);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub/"] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Calendar access" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/hub/calendar-access");
  });

  it("a Viewer sees no Add a subscriber link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NoD.Viewer"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/nod/api/subscribers/search") return jsonResponse(200, { total: 0, page: 1, pageSize: 50, items: [] });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub/subscribers"] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Subscribers" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add a subscriber" })).toBeNull();
  });
});
