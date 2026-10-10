import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { LookupScreen } from "./LookupScreen";
import { LookupsScreen } from "./LookupsScreen";

const KEYWORDS = {
  name: "keywords",
  label: "HQ tags",
  singular: "HQ tag",
  editable: true,
  minRole: "Calendar.Administrator",
  nameMax: 255,
  extras: [],
  rows: [
    { id: 1, name: "Sample keyword", sortOrder: 1, isActive: true, extras: {} },
    { id: 2, name: "Second keyword", sortOrder: 2, isActive: false, extras: {} },
  ],
};
const CATEGORIES = { ...KEYWORDS, name: "categories", label: "Categories", singular: "category", editable: false, minRole: "Calendar.SysAdmin", nameMax: 50, rows: [{ id: 58, name: "Sample category", sortOrder: 1, isActive: true, extras: {} }] };

function stub(calls: { url: string; init?: RequestInit }[], respond: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const custom = respond(url, init);
      if (custom) return custom;
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/lookups") return jsonResponse(200, [KEYWORDS, CATEGORIES].map(({ rows: _r, ...s }) => s));
      if (url === "/calendar/api/lookups/keywords" && (!init?.method || init.method === "GET")) return jsonResponse(200, KEYWORDS);
      if (url === "/calendar/api/lookups/categories") return jsonResponse(200, CATEGORIES);
      if (url === "/calendar/api/lookups/keywords" && init?.method === "POST") return jsonResponse(201, { id: 3, name: "New keyword", sortOrder: 3, isActive: true, extras: {} });
      if (url === "/calendar/api/lookups/keywords/order") return jsonResponse(200, [KEYWORDS.rows[1], KEYWORDS.rows[0]]);
      if (url.startsWith("/calendar/api/lookups/keywords/")) return jsonResponse(200, { ...KEYWORDS.rows[0], ...JSON.parse(init!.body as string) });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderAt = (path: string) =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/lookups" element={<LookupsScreen />} />
            <Route path="/calendar/lookups/:name" element={<LookupScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("Calendar lookup screens", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists every lookup, marking the ones this user can only read", async () => {
    stub([]);
    renderAt("/calendar/lookups");
    await waitFor(() => expect(document.title).toBe("Calendar lookups — GCPE News Staff"));
    expect(await screen.findByRole("link", { name: "HQ tags" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Categories (read only)" })).toBeInTheDocument();
  });

  it("shows rows, active and inactive, and adds a row", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("/calendar/lookups/keywords");
    await waitFor(() => expect(document.title).toBe("HQ tags — GCPE News Staff"));
    const table = await screen.findByRole("table", { name: "HQ tags" });
    expect(within(table).getByText("Sample keyword")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Second keyword/ })).toHaveTextContent("Inactive");
    const user = userEvent.setup();
    const add = screen.getByRole("form", { name: "Add an HQ tag" });
    await user.type(within(add).getByLabelText("Name"), "New keyword");
    await user.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.init?.method === "POST")!.init!.body as string)).toEqual({ name: "New keyword", extras: {} });
    expect(await screen.findByRole("status")).toHaveTextContent("Added New keyword.");
  });

  it("renames and deactivates a row", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("/calendar/lookups/keywords");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit Sample keyword" }));
    const form = screen.getByRole("form", { name: "Edit Sample keyword" });
    const name = within(form).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Renamed keyword");
    await user.click(within(form).getByLabelText("Active"));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/api/lookups/keywords/1")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url === "/calendar/api/lookups/keywords/1")!.init!.body as string)).toEqual({ name: "Renamed keyword", extras: {}, isActive: false });
  });

  it("moves a row up by posting the whole order", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("/calendar/lookups/keywords");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Move Second keyword up" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/order"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/order"))!.init!.body as string)).toEqual({ ids: [2, 1] });
  });

  it("shows a stale reorder's 409 as an alert", async () => {
    stub([], (url) => (url === "/calendar/api/lookups/keywords/order" ? jsonResponse(409, { error: "the list changed since you loaded it: reload and try again" }) : undefined));
    renderAt("/calendar/lookups/keywords");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Move Second keyword up" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the list changed since you loaded it: reload and try again");
  });

  it("a read-only lookup has no add, edit or move controls and says who can change it", async () => {
    stub([]);
    renderAt("/calendar/lookups/categories");
    expect(await screen.findByText("Only a System Administrator can change categories.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /Add/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit|Move/ })).toBeNull();
  });

  it("shows the server's refusal next to the form", async () => {
    stub([], (url, init) => (url === "/calendar/api/lookups/keywords" && init?.method === "POST" ? jsonResponse(409, { error: "an active row with that name already exists" }) : undefined));
    renderAt("/calendar/lookups/keywords");
    const user = userEvent.setup();
    const add = await screen.findByRole("form", { name: "Add an HQ tag" });
    await user.type(within(add).getByLabelText("Name"), "Sample keyword");
    await user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByRole("alert")).toHaveTextContent("an active row with that name already exists");
  });
});
