import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscribersScreen } from "./SubscribersScreen";
import type { SubscriberPage } from "./types";

const PAGE: SubscriberPage = {
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    { id: "11111111-1111-1111-1111-111111111111", email: "pat@example.test", status: "active", source: "self", asItHappens: true, digest: false, createdAt: "2026-10-01T17:00:00.000Z", needsAttention: null },
    { id: "22222222-2222-2222-2222-222222222222", email: "lee@example.test", status: "disabled", source: "admin", asItHappens: false, digest: true, createdAt: "2026-10-02T17:00:00.000Z", needsAttention: null },
  ],
};

type Call = { url: string; method: string; body: unknown };

// Search terms never travel in a URL (decided after the plan was written): the search box's
// value lives in component state and reaches the server as a POST body, never a query string.
function stub(roles: string[], onBulk?: (body: unknown) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nod/api/subscribers/search") return jsonResponse(200, PAGE);
      if (url === "/nod/api/subscribers/bulk") return jsonResponse(200, onBulk?.(JSON.parse(String(init!.body))) ?? { changed: 0, skipped: [] });
      throw new Error(`unhandled: ${url}`);
    }),
  );
  return calls;
}

function renderAt(path = "/subscribers") {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers" element={<SubscribersScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("SubscribersScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("sets the title and lists results with status and timing", async () => {
    stub(["NoD.Viewer"]);
    renderAt();
    expect(await screen.findByRole("link", { name: "pat@example.test" })).toHaveAttribute("href", "/subscribers/11111111-1111-1111-1111-111111111111");
    expect(screen.getByRole("cell", { name: "Disabled" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Daily digest" })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Subscribers — GCPE News Staff"));
  });

  it("searches by POSTing the term and status, never putting the term in the URL", async () => {
    const calls = stub(["NoD.Viewer"]);
    renderAt();
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "pat@example.test" });
    await user.type(screen.getByRole("textbox", { name: "Email contains" }), "pat_");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "disabled");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === "/nod/api/subscribers/search" && c.method === "POST" && c.body && (c.body as Record<string, unknown>).q === "pat_" && (c.body as Record<string, unknown>).status === "disabled"),
      ).toBe(true),
    );
    // The term itself never appears in a URL anywhere this screen controls.
    expect(window.location.search).not.toContain("pat_");
    expect(calls.every((c) => !c.url.includes("pat_"))).toBe(true);
  });

  it("a Viewer gets no selection checkboxes, bulk actions or Add link", async () => {
    stub(["NoD.Viewer"]);
    renderAt();
    await screen.findByRole("link", { name: "pat@example.test" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Add a subscriber" })).toBeNull();
  });

  it("bulk delete asks first; Cancel sends nothing; Confirm sends the selected ids and reports the outcome", async () => {
    const calls = stub(["NoD.Editor"], () => ({ changed: 1, skipped: [{ id: "22222222-2222-2222-2222-222222222222", reason: "unchanged" }] }));
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 2 subscribers?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.url === "/nod/api/subscribers/bulk")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/nod/api/subscribers/bulk")?.body).toEqual({ action: "delete", ids: PAGE.items.map((i) => i.id) }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 changed. 1 skipped: already in that state.");
  });

  it("a bulk row that failed unexpectedly is reported as a skip to try again", async () => {
    const calls = stub(["NoD.Editor"], () => ({ changed: 1, skipped: [{ id: "22222222-2222-2222-2222-222222222222", reason: "error" }] }));
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: "Deactivate selected (2)" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm deactivate" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nod/api/subscribers/bulk")).toBe(true));
    expect(await screen.findByRole("status")).toHaveTextContent("1 changed. 1 skipped: couldn't change – try again.");
  });
  it("an invalid status or page in the URL falls back to all and page 1 rather than being sent", async () => {
    const calls = stub(["NoD.Viewer"]);
    renderAt("/subscribers?status=bogus&page=-2");
    await screen.findByRole("link", { name: "pat@example.test" });
    const searches = calls.filter((c) => c.url === "/nod/api/subscribers/search");
    expect(searches.map((c) => c.body)).toEqual([{}]);
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("all");
  });

  it("a slow earlier search that answers after a later one never replaces the later results", async () => {
    const LEE: SubscriberPage = { ...PAGE, total: 1, items: [PAGE.items[1]!] };
    let answerFirst!: () => void;
    let searches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: ["NoD.Viewer"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/nod/api/subscribers/search") {
          searches++;
          if (searches === 1) return new Promise<Response>((resolve) => (answerFirst = () => resolve(jsonResponse(200, PAGE))));
          return jsonResponse(200, LEE);
        }
        throw new Error(`unhandled: ${url}`);
      }),
    );
    renderAt();
    const user = userEvent.setup();
    await waitFor(() => expect(searches).toBe(1));
    await user.type(screen.getByRole("textbox", { name: "Email contains" }), "lee");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("link", { name: "lee@example.test" })).toBeInTheDocument();
    answerFirst();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: "pat@example.test" })).toBeNull();
    expect(screen.getByRole("link", { name: "lee@example.test" })).toBeInTheDocument();
  });
});
