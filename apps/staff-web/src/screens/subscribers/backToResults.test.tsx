import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscribersScreen } from "./SubscribersScreen";
import { SubscriberScreen } from "./SubscriberScreen";
import { backToFrom } from "./backToResults";
import type { SubscriberDetail, SubscriberPage } from "./types";

const ID = "11111111-1111-1111-1111-111111111111";
const PAGE: SubscriberPage = {
  total: 1,
  page: 1,
  pageSize: 50,
  items: [{ id: ID, email: "pat@example.test", status: "active", source: "self", asItHappens: true, digest: false, createdAt: "2026-10-01T17:00:00.000Z", needsAttention: null }],
};
const DETAIL: SubscriberDetail = {
  id: ID, email: "pat@example.test", status: "active", source: "self", asItHappens: true, digest: false, createdAt: "2026-09-01T17:00:00.000Z",
  needsAttention: null, verifiedAt: null, endedAt: null, attentionAt: null, allNews: true, listKeys: [], mediaLists: [], mediaHubLinked: false,
  disabledReason: null, bouncedEmails: 0, bounceWindowDays: 15,
};

function setup(page: SubscriberPage = PAGE) {
  const searches: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NoD.Viewer"] }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nod/api/subscribers/search") {
        searches.push(init?.body ? JSON.parse(String(init.body)) : {});
        return jsonResponse(200, page);
      }
      if (url === `/nod/api/subscribers/${ID}`) return jsonResponse(200, DETAIL);
      if (url === "/nod/api/subscriber-list-options") return jsonResponse(200, { groups: [] });
      throw new Error(`unhandled: ${url}`);
    }),
  );
  const router = createMemoryRouter(
    [
      { path: "/subscribers", element: <RequireAuth><SubscribersScreen /></RequireAuth> },
      { path: "/subscribers/:id", element: <RequireAuth><SubscriberScreen /></RequireAuth> },
    ],
    { initialEntries: ["/subscribers?status=active"] },
  );
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { router, searches };
}

describe("Find subscribers keeps its results when you come back", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Back to results, on the subscriber, returns to the same search — term included, and still not in the URL", async () => {
    const user = userEvent.setup();
    const { router, searches } = setup();
    await screen.findByRole("link", { name: "pat@example.test" });
    await user.type(screen.getByRole("textbox", { name: /^Email contains/ }), "pat@");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(searches.at(-1)).toEqual({ q: "pat@", status: "active" }));
    await user.click(screen.getByRole("link", { name: "pat@example.test" }));
    await user.click(await screen.findByRole("link", { name: "Back to results" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: /^Email contains/ })).toHaveValue("pat@"));
    expect(searches.at(-1)).toEqual({ q: "pat@", status: "active" });
    expect(router.state.location.search).toBe("?status=active");
    expect(router.state.location.search).not.toContain("pat");
  });

  it("the browser's Back does the same", async () => {
    const user = userEvent.setup();
    const { router, searches } = setup();
    await screen.findByRole("link", { name: "pat@example.test" });
    await user.type(screen.getByRole("textbox", { name: /^Email contains/ }), "pat@");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(searches.at(-1)).toEqual({ q: "pat@", status: "active" }));
    await user.click(screen.getByRole("link", { name: "pat@example.test" }));
    await screen.findByRole("heading", { name: "Subscriber" });
    await router.navigate(-1);
    await waitFor(() => expect(screen.getByRole("textbox", { name: /^Email contains/ })).toHaveValue("pat@"));
    expect(searches.at(-1)).toEqual({ q: "pat@", status: "active" });
  });

  it("paging keeps what's typed in the box but not yet searched, and pages the search that was run", async () => {
    const user = userEvent.setup();
    const { searches } = setup({ ...PAGE, total: 120 });
    await screen.findByRole("link", { name: "pat@example.test" });
    const q = screen.getByRole("textbox", { name: /^Email contains/ });
    await user.type(q, "pat@");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(searches.at(-1)).toEqual({ q: "pat@", status: "active" }));
    await user.type(q, "example");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(searches.at(-1)).toEqual({ q: "pat@", status: "active", page: 2 }));
    expect(q).toHaveValue("pat@example");
  });

  it("a subscriber opened any other way has no Back to results", async () => {
    setup();
    expect(backToFrom(null)).toBeNull();
    expect(backToFrom({ backTo: { path: "https://elsewhere.example", state: { subscribersQ: "" } } })).toBeNull();
    expect(backToFrom({ backTo: { path: "//elsewhere.example", state: { subscribersQ: "" } } })).toBeNull();
    expect(backToFrom({ backTo: { path: "/subscribers?page=2", state: { subscribersQ: "x" } } })).toEqual({ path: "/subscribers?page=2", state: { subscribersQ: "x" } });
  });
});
