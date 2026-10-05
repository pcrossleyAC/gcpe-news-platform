import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { createMemoryRouter, MemoryRouter, RouterProvider, Route, Routes, useParams } from "react-router";
import type { ReleaseListItem, ReleasePage } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
import { SearchScreen } from "./SearchScreen";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function item(overrides: Partial<ReleaseListItem> = {}): ReleaseListItem {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    type: "release",
    key: null,
    reference: null,
    status: "published",
    statusText: "Published",
    leadOrganization: "Education",
    pageTitle: "A page title",
    headline: "A headline",
    location: "VICTORIA",
    summary: "A summary.",
    publishAt: null,
    releasedAt: "2026-06-14T18:00:00Z",
    activityId: null,
    approved: false,
    flickrAlert: null,
    ...overrides,
  };
}

function searchPage(items: ReleaseListItem[], overrides: Partial<ReleasePage<ReleaseListItem>> = {}): ReleasePage<ReleaseListItem> {
  return { items, total: items.length, page: 1, pageSize: 20, ...overrides };
}

const CATEGORIES = {
  ministries: [{ key: "educ", name: "Education", abbreviation: "EDUC" }],
  sectors: [{ key: "econ", name: "Economy" }],
  themes: [],
  tags: [],
};

interface StubOptions {
  gotoHit?: { id: string } | null;
  gotoCalls?: string[];
  searchCalls?: string[];
  searchResult?: ReleasePage<ReleaseListItem>;
}

function stubFetch({ gotoHit = null, gotoCalls = [], searchCalls = [], searchResult = searchPage([]) }: StubOptions = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") {
        return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
      }
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url === "/nrms/api/categories") return jsonResponse(200, CATEGORIES);
      if (url.startsWith("/nrms/api/goto")) {
        gotoCalls.push(url);
        return gotoHit ? jsonResponse(200, gotoHit) : jsonResponse(404, { error: "not found" });
      }
      if (url.startsWith("/nrms/api/search")) {
        searchCalls.push(url);
        return jsonResponse(200, searchResult);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

// Stands in for the real ReleasePlaceholder route — just enough to prove a goto hit navigated
// to the right id, without pulling that component into this test.
function LandedOnRelease(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  return <p>landed on release {id}</p>;
}

function renderSearch(initialPath = "/search") {
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/search" element={<SearchScreen />} />
          <Route path="/releases/:id" element={<LandedOnRelease />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("SearchScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("has exactly one h1", async () => {
    stubFetch();
    renderSearch();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("a goto hit navigates straight to the release", async () => {
    const gotoCalls: string[] = [];
    stubFetch({ gotoHit: { id: "22222222-2222-2222-2222-222222222222" }, gotoCalls });
    renderSearch();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/search/i), "NEWS-01234");
    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("landed on release 22222222-2222-2222-2222-222222222222")).toBeInTheDocument();
    expect(gotoCalls).toEqual(["/nrms/api/goto?q=NEWS-01234"]);
  });

  it("a pasted public URL also goes through goto first", async () => {
    const gotoCalls: string[] = [];
    stubFetch({ gotoHit: { id: "33333333-3333-3333-3333-333333333333" }, gotoCalls });
    renderSearch();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/search/i), "https://news.gov.bc.ca/releases/2026EDU0001-000123");
    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("landed on release 33333333-3333-3333-3333-333333333333")).toBeInTheDocument();
    expect(gotoCalls).toEqual(["/nrms/api/goto?q=https%3A%2F%2Fnews.gov.bc.ca%2Freleases%2F2026EDU0001-000123"]);
  });

  it("a goto miss falls back to showing search results", async () => {
    const gotoCalls: string[] = [];
    const searchCalls: string[] = [];
    stubFetch({ gotoHit: null, gotoCalls, searchCalls, searchResult: searchPage([item({ headline: "Found by search" })]) });
    renderSearch();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/search/i), "schools funding");
    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("Found by search")).toBeInTheDocument();
    expect(gotoCalls).toEqual(["/nrms/api/goto?q=schools%20funding"]);
    expect(searchCalls).toEqual(["/nrms/api/search?q=schools+funding&page=1"]);
  });

  it("combines the ministry and sector filters with the query (AND)", async () => {
    const searchCalls: string[] = [];
    stubFetch({ gotoHit: null, searchCalls, searchResult: searchPage([item()]) });
    renderSearch();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/search/i), "schools");
    await user.click(screen.getByRole("button", { name: /search/i }));
    await screen.findByText("A headline");

    await user.selectOptions(screen.getByLabelText(/ministry/i), "educ");
    await user.selectOptions(screen.getByLabelText(/sector/i), "econ");

    await waitFor(() => expect(searchCalls.at(-1)).toContain("ministry=educ"));
    expect(searchCalls.at(-1)).toContain("sector=econ");
    expect(searchCalls.at(-1)).toContain("q=schools");
  });

  it("keeps the ministry/sector filters when submitting a new search term, and resets the page", async () => {
    // Fix round 1, finding 2: submitting a new term after a goto miss used to replace the
    // whole query string (setSearchParams({ q })), dropping any filter already selected.
    const gotoCalls: string[] = [];
    const searchCalls: string[] = [];
    stubFetch({ gotoHit: null, gotoCalls, searchCalls, searchResult: searchPage([item()]) });
    renderSearch("/search?q=first+term&ministry=educ&sector=econ&page=3");
    await waitFor(() => expect(searchCalls).toHaveLength(1)); // the initial load, before the new submission

    const user = userEvent.setup();
    const box = screen.getByLabelText(/search/i) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "second term");
    await user.click(screen.getByRole("button", { name: /search/i }));

    // Only this submission calls goto — the initial load reads q straight off the URL.
    await waitFor(() => expect(gotoCalls).toHaveLength(1));
    expect(gotoCalls.at(-1)).toBe("/nrms/api/goto?q=second%20term");
    await waitFor(() => expect(searchCalls).toHaveLength(2));
    const last = searchCalls.at(-1)!;
    expect(last).toContain("q=second+term");
    expect(last).toContain("ministry=educ");
    expect(last).toContain("sector=econ");
    expect(last).not.toContain("page=3");
  });

  it("shows the ApiError's own message on a goto failure, not a generic one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url === "/nrms/api/categories") return jsonResponse(200, CATEGORIES);
        if (url.startsWith("/nrms/api/goto")) return jsonResponse(503, { error: "The search index is unavailable." });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderSearch();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/search/i), "schools");
    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("The search index is unavailable.")).toBeInTheDocument();
  });

  it("replaces (not pushes) the URL to the last valid page when the current page has no items but total > 0", async () => {
    // Fix round 1, finding 3: an out-of-range page used to render "Showing 101–30 of 30".
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") {
          return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
        }
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
        if (url === "/nrms/api/categories") return jsonResponse(200, CATEGORIES);
        if (url.startsWith("/nrms/api/search")) {
          const page5 = new URLSearchParams(url.split("?")[1]).get("page") === "5";
          return jsonResponse(200, page5 ? searchPage([], { total: 30, page: 5 }) : searchPage([item({ headline: "Page two result" })], { total: 30, page: 2 }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const router = createMemoryRouter([{ path: "/search", element: <SearchScreen /> }], {
      initialEntries: ["/search", "/search?q=schools&page=5"],
      initialIndex: 1,
    });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );

    expect(await screen.findByText("Page two result")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?q=schools&page=2");

    // If the correction had pushed a new entry instead of replacing, going back once would
    // land on the bad "?page=5" state rather than skipping straight past it.
    router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe("/search"));
  });

  it("has no serious/critical axe violations", async () => {
    stubFetch({ searchResult: searchPage([item()]) });
    const { container } = renderSearch();
    await screen.findByRole("heading", { level: 1 });
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toEqual([]);
  });
});
