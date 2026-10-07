import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { createMemoryRouter, MemoryRouter, RouterProvider, Route, Routes } from "react-router";
import type { ReleaseListItem, ReleasePage } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
import { ReleaseListScreen } from "./ReleaseListScreen";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function item(overrides: Partial<ReleaseListItem> = {}): ReleaseListItem {
  return {
    id: "11111111-1111-1111-1111-111111111111",
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
    ...overrides,
  };
}

function page(items: ReleaseListItem[], overrides: Partial<ReleasePage<ReleaseListItem>> = {}): ReleasePage<ReleaseListItem> {
  return { items, total: items.length, page: 1, pageSize: 25, ...overrides };
}

interface StubOptions {
  roles?: string[];
  releasesPage?: ReleasePage<ReleaseListItem>;
}

function stubFetch({ roles = ["NRMS.Viewer"], releasesPage = page([item()]) }: StubOptions = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url.startsWith("/nrms/api/releases")) return jsonResponse(200, releasesPage);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

/** Mirrors the real route table (router.tsx): each folder is its own static route, so a
 * NavLink click actually remounts {@link ReleaseListScreen} with the new `folder` prop, the
 * way `createAppRouter` wires it up. */
function renderScreen(_folder: "drafts" | "scheduled" | "published", initialPath: string, opts: StubOptions = {}) {
  const calls = stubFetch(opts);
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/releases/drafts" element={<ReleaseListScreen folder="drafts" />} />
          <Route path="/releases/scheduled" element={<ReleaseListScreen folder="scheduled" />} />
          <Route path="/releases/published" element={<ReleaseListScreen folder="published" />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  return calls;
}

describe("ReleaseListScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("requests the folder's releases and renders them", async () => {
    const calls = renderScreen("drafts", "/releases/drafts", { releasesPage: page([item({ headline: "First headline" })]) });
    expect(await screen.findByText("First headline")).toBeInTheDocument();
    const releasesCall = calls.find((c) => c.startsWith("/nrms/api/releases"));
    expect(releasesCall).toBe("/nrms/api/releases?folder=drafts&type=all&page=1&pageSize=25");
  });

  it("has exactly one h1", async () => {
    renderScreen("drafts", "/releases/drafts");
    await screen.findByText("A headline");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  // I5: document.title matches the screen's own h1.
  it("sets the document title", async () => {
    renderScreen("drafts", "/releases/drafts");
    await screen.findByText("A headline");
    await waitFor(() => expect(document.title).toBe("Releases — GCPE News Staff"));
  });

  it("changing the type filter re-queries with that type and resets to page 1", async () => {
    const calls = renderScreen("drafts", "/releases/drafts?page=3");
    await screen.findByText("A headline");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/type/i), "story");

    await waitFor(() => expect(calls.filter((c) => c.startsWith("/nrms/api/releases")).length).toBeGreaterThan(1));
    const last = calls.filter((c) => c.startsWith("/nrms/api/releases")).at(-1);
    expect(last).toBe("/nrms/api/releases?folder=drafts&type=story&page=1&pageSize=25");
  });

  it('the type filter never offers "Update" (it only appears under All)', async () => {
    renderScreen("drafts", "/releases/drafts");
    await screen.findByText("A headline");
    const select = screen.getByLabelText(/type/i) as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(["All", "Release", "Story", "Factsheet", "Advisory"]);
  });

  it('shows the "Showing x–y of z" paging text', async () => {
    renderScreen("drafts", "/releases/drafts?page=2", {
      releasesPage: { items: [item()], total: 112, page: 2, pageSize: 25 },
    });
    expect(await screen.findByText("Showing 26–50 of 112")).toBeInTheDocument();
  });

  it("an Editor sees the New release button", async () => {
    renderScreen("drafts", "/releases/drafts", { roles: ["NRMS.Editor"] });
    await screen.findByText("A headline");
    expect(screen.getByRole("link", { name: "New release" })).toBeInTheDocument();
  });

  it("a Viewer never sees the New release button", async () => {
    renderScreen("drafts", "/releases/drafts", { roles: ["NRMS.Viewer"] });
    await screen.findByText("A headline");
    expect(screen.queryByRole("link", { name: "New release" })).not.toBeInTheDocument();
  });

  it("switching tabs requests the new folder", async () => {
    const calls = renderScreen("drafts", "/releases/drafts");
    await screen.findByText("A headline");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Scheduled" }));
    await waitFor(() => expect(calls.filter((c) => c.startsWith("/nrms/api/releases")).at(-1)).toContain("folder=scheduled"));
  });

  it("replaces (not pushes) the URL to the last valid page when the current page has no items but total > 0", async () => {
    // Fix round 1, finding 3: an out-of-range page used to render "Showing 101–30 of 30".
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url.startsWith("/nrms/api/releases")) {
          const page5 = new URLSearchParams(url.split("?")[1]).get("page") === "5";
          return jsonResponse(200, page5 ? { items: [], total: 30, page: 5, pageSize: 25 } : { items: [item({ headline: "Page two headline" })], total: 30, page: 2, pageSize: 25 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const router = createMemoryRouter([{ path: "/releases/drafts", element: <ReleaseListScreen folder="drafts" /> }], {
      initialEntries: ["/releases/drafts", "/releases/drafts?page=5"],
      initialIndex: 1,
    });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );

    expect(await screen.findByText("Page two headline")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?page=2");

    // If the correction had pushed a new entry instead of replacing, going back once would
    // land on the bad "?page=5" state rather than skipping straight past it.
    router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe("/releases/drafts"));
  });

  it("has no serious/critical axe violations", async () => {
    stubFetch({ roles: ["NRMS.Editor"] });
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={["/releases/drafts"]}>
          <ReleaseListScreen folder="drafts" />
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByText("A headline");
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toEqual([]);
  });
});
