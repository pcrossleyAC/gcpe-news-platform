import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { ListsScreen } from "./ListsScreen";
import type { StaffListsView } from "./types";

const VIEW: StaffListsView = {
  allNews: 12,
  categories: [
    {
      key: "ministries", name: "Ministries", enabled: true, namesFrom: "Core", editable: true,
      lists: [
        { listKey: "ministries:health", key: "health", name: "Health", active: true, enabled: true, subscribers: 40 },
        { listKey: "ministries:energy", key: "energy", name: "Energy", active: true, enabled: false, subscribers: 3 },
        { listKey: "ministries:old", key: "old", name: "Old ministry", active: false, enabled: true, subscribers: 0 },
      ],
    },
    { key: "media-distribution-lists", name: "Media distribution lists", enabled: true, namesFrom: "NRMS", editable: false, lists: [{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, enabled: true, subscribers: 9 }] },
  ],
};

type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], onPut?: (url: string) => Response | undefined, onLoad?: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/list-categories") return onLoad?.() ?? jsonResponse(200, VIEW);
    if (init?.method === "PUT") return onPut?.(url) ?? jsonResponse(200, { changed: true });
    throw new Error(`unhandled: ${url}`);
  }));
  return calls;
}

function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/lists"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/lists" element={<ListsScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("ListsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows counts, where names come from, retired and not-offered lists; a Viewer gets no controls", async () => {
    stub(["NoD.Viewer"]);
    renderIt();
    expect(await screen.findByText("All news: 12 active subscribers.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Ministries" })).toBeInTheDocument();
    expect(screen.getByText("Names come from Core.")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Health 40 Yes/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Energy 3 No/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Old ministry \(retired in Core\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Lists and categories — GCPE News Staff"));
  });

  it("an Admin stops offering a list and moves one up; media lists have no controls", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Offer Health" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Health is no longer offered.");
    expect(calls).toContainEqual({ url: "/nod/api/lists/ministries%3Ahealth", method: "PUT", body: { enabled: false } });
    await user.click(screen.getByRole("button", { name: "Move Energy up" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ url: "/nod/api/list-categories/ministries/list-order", method: "PUT", body: { listKeys: ["ministries:energy", "ministries:health", "ministries:old"] } }),
    );
    expect(screen.queryByRole("checkbox", { name: "Offer Budget" })).toBeNull();
    // getByText matches an element's own text nodes only, so the sentence around the link is
    // checked through the link itself.
    expect(screen.getByRole("link", { name: "Media list names" })).toHaveAttribute("href", "/media-list-names");
  });

  it("an Editor sees the lists but can't change them", async () => {
    stub(["NoD.Editor"]);
    renderIt();
    expect(await screen.findByRole("row", { name: /Health 40 Yes/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
  });

  it("Offered means the list is active, switched on and in a category that's switched on; media lists are managed in NRMS", async () => {
    const view: StaffListsView = {
      allNews: 0,
      categories: [
        { ...VIEW.categories[0]!, enabled: true },
        {
          key: "sectors", name: "Sectors", enabled: false, namesFrom: "Core", editable: true,
          lists: [{ listKey: "sectors:energy", key: "energy", name: "Energy sector", active: true, enabled: true, subscribers: 5 }],
        },
        VIEW.categories[1]!,
      ],
    };
    stub(["NoD.Viewer"], undefined, () => jsonResponse(200, view));
    renderIt();
    expect(await screen.findByRole("row", { name: /Health 40 Yes/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Energy 3 No$/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Old ministry \(retired in Core\) 0 No \(retired\)/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Energy sector 5 No \(category not offered\)/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Budget 9 Managed in NRMS/ })).toBeInTheDocument();
  });

  it("an earlier, slower reload never replaces a later one", async () => {
    const pending: ((r: Response) => void)[] = [];
    let loads = 0;
    stub(["NoD.Admin"], undefined, () => (++loads === 1 ? jsonResponse(200, VIEW) : new Promise<Response>((resolve) => pending.push(resolve))));
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Offer Health" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Move Energy up" }));
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[1]!(jsonResponse(200, { ...VIEW, allNews: 99 }));
    expect(await screen.findByText("All news: 99 active subscribers.")).toBeInTheDocument();
    pending[0]!(jsonResponse(200, VIEW));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("All news: 99 active subscribers.")).toBeInTheDocument();
    expect(screen.queryByText("All news: 12 active subscribers.")).toBeNull();
  });

  it("a stale order reloads and says so", async () => {
    stub(["NoD.Admin"], (url) => (url.endsWith("/order") ? jsonResponse(409, { error: "order-out-of-date" }) : undefined));
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Move Media distribution lists up" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The lists changed while you were looking");
  });
});
