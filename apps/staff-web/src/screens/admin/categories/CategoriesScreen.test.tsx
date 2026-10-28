import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CategoriesScreen } from "./CategoriesScreen";

const SOCIAL: { twitterUsername: string | null; flickrUrl: null; youtubeUrl: null; audioUrl: null } = { twitterUsername: "@bcgov", flickrUrl: null, youtubeUrl: null, audioUrl: null };
const NO_SOCIAL: typeof SOCIAL = { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null };
const rec = (kind: string, key: string, displayName: string | null, sortOrder: number, isActive = true, social = NO_SOCIAL) => ({
  kind, key, displayName, sortOrder, isActive, social, updatedAt: "2026-10-01T00:00:00.000Z",
});
const BY_KIND: Record<string, ReturnType<typeof rec>[]> = {
  sector: [rec("sector", "Health_Care", "Health", 1, true, SOCIAL), rec("sector", "education", "Education", 4), rec("sector", "legacy", null, 2)],
  theme: [rec("theme", "climate", "Climate", 1)],
  tag: [rec("tag", "budget", "Budget", 7)],
};
type Call = { url: string; method: string; body: any };
function stub(roles: string[], onPut?: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    const list = /^\/core\/api\/terms\/(\w+)$/.exec(url);
    if (list && method === "GET") return jsonResponse(200, BY_KIND[list[1]!]);
    if (url.startsWith("/core/api/terms/") && method === "PUT") return onPut?.() ?? jsonResponse(200, {});
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/categories"]}>
        <RequireAuth>
          <Routes>
            <Route path="/categories" element={<CategoriesScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("CategoriesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("a Core.Admin sees the Sectors table from GET /core/api/terms/sector; switching Show to Tags loads /terms/tag", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    expect(await screen.findByRole("heading", { level: 1, name: "Sectors, themes and tags" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Sectors" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/core/api/terms/sector")).toBe(true);
    expect(screen.queryByRole("radio", { name: "Services" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Tags" }));
    expect(await screen.findByRole("table", { name: "Tags" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/core/api/terms/tag")).toBe(true);
    expect(screen.queryByRole("table", { name: "Sectors" })).toBeNull();
  });

  it("a user without Core.Admin sees the permission message and no table", async () => {
    const calls = stub(["NRMS.SiteEditor"]);
    renderIt();
    expect(await screen.findByText("You don't have permission to manage sectors, themes and tags.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/core/api/terms"))).toBe(false);
    await waitFor(() => expect(document.title).toBe("Sectors, themes and tags — GCPE News Staff"));
  });

  it("renaming a sector sends PUT with the loaded social unchanged and the new displayName; success text names the key", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "Name for Health_Care" });
    await user.clear(name);
    await user.type(name, "Health and wellness");
    await user.click(screen.getByRole("button", { name: "Save Health_Care" }));
    await waitFor(() =>
      expect(puts(calls)).toEqual([
        { url: "/core/api/terms/sector/Health_Care", method: "PUT", body: { ...BY_KIND.sector![0], displayName: "Health and wellness", sortOrder: 1, isActive: true } },
      ]),
    );
    expect(puts(calls)[0]!.body.social).toEqual(SOCIAL);
    expect(await screen.findByRole("status")).toHaveTextContent("Health_Care saved.");
    expect(calls.filter((c) => c.url === "/core/api/terms/sector" && c.method === "GET").length).toBeGreaterThan(1);
  });

  it("clearing Active opens the Retire dialog; Cancel sends nothing; Retire sends isActive false", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "education active" }));
    await user.click(screen.getByRole("button", { name: "Save education" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Retire Education?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("It leaves the public site's lists, the subscribe page and the release editor's choices. Releases already tagged keep it.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(puts(calls)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save education" }));
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]!.url).toBe("/core/api/terms/sector/education");
    expect(puts(calls)[0]!.body).toMatchObject({ isActive: false, displayName: "Education", sortOrder: 4 });
  });

  it.each(["", "1.5"])("an Order of %j shows 'Order must be a whole number.' and sends nothing", async (bad) => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const order = await screen.findByRole("spinbutton", { name: "Order for education" });
    await user.clear(order);
    if (bad) await user.type(order, bad);
    await user.click(screen.getByRole("button", { name: "Save education" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Order must be a whole number.");
    expect(order).toHaveAttribute("aria-invalid", "true");
    expect(order).toHaveFocus();
    expect(order).toHaveAccessibleDescription("Order must be a whole number.");
    expect(puts(calls)).toEqual([]);
  });

  it("Add a tag: Name 'Jobs & Economy' suggests key 'jobs-economy'; a hand-edited key is kept when the name changes again", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Tags" }));
    const form = await screen.findByRole("form", { name: "Add a tag" });
    const name = within(form).getByRole("textbox", { name: "Name" });
    const key = within(form).getByRole("textbox", { name: "Key" });
    await user.type(name, "Jobs & Economy");
    expect(key).toHaveValue("jobs-economy");
    await user.clear(key);
    await user.type(key, "my-key");
    await user.type(name, "!");
    expect(key).toHaveValue("my-key");
    await user.click(within(form).getByRole("button", { name: "Add tag" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toEqual({
      url: "/core/api/terms/tag/my-key",
      method: "PUT",
      body: { kind: "tag", key: "my-key", displayName: "Jobs & Economy!", sortOrder: 8, isActive: true, social: NO_SOCIAL },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("my-key");
  });

  it("Add answers 409: the reactivate message shows beside the form", async () => {
    stub(["Core.Admin"], () => jsonResponse(409, { error: "key-taken" }));
    renderIt();
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Add a sector" });
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "Health");
    await user.click(within(form).getByRole("button", { name: "Add sector" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That key is already used. To bring a retired one back, tick Active on its row.");
    const keyField = within(form).getByRole("textbox", { name: "Key" });
    expect(keyField).toHaveAttribute("aria-invalid", "true");
    expect(keyField).toHaveFocus();
    expect(keyField).toHaveAccessibleDescription("That key is already used. To bring a retired one back, tick Active on its row.");
  });

  it.each([
    [{ error: "key-format" }, 400, "Keys use lowercase letters, numbers and hyphens (at most 100)."],
    [{ error: "key-taken" }, 409, "That key is already used. To bring a retired one back, tick Active on its row."],
    [{ error: "name-required" }, 400, "Name is required."],
    [{ error: "name-too-long" }, 400, "Name is too long (at most 100 characters)."],
    [{ error: "boom" }, 500, "Couldn't save. Try again."],
  ])("a row save answering %j explains it", async (body, status, text) => {
    stub(["Core.Admin"], () => jsonResponse(status, body));
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save education" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("a row with a null name shows an empty Name field and saving it blank shows 'Name is required.'", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "Name for legacy" });
    expect(name).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save legacy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required.");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveFocus();
    expect(name).toHaveAccessibleDescription("Name is required.");
    expect(puts(calls)).toEqual([]);
  });

  it("Enter pressed twice while an Add is in flight sends one request", async () => {
    let release!: (r: Response) => void;
    const calls = stub(["Core.Admin"], () => new Promise<Response>((r) => (release = r)));
    renderIt();
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Add a sector" });
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "Health");
    await user.keyboard("{Enter}{Enter}");
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    release(jsonResponse(200, {}));
    await screen.findByRole("status");
    expect(puts(calls)).toHaveLength(1);
  });

  it("a save finishing after Show was switched leaves the new kind's table alone", async () => {
    let release!: (r: Response) => void;
    stub(["Core.Admin"], () => new Promise<Response>((r) => (release = r)));
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save education" }));
    await waitFor(() => expect(release).toBeDefined());
    await user.click(screen.getByRole("radio", { name: "Tags" }));
    expect(await screen.findByRole("table", { name: "Tags" })).toBeInTheDocument();
    release(jsonResponse(200, {}));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("table", { name: "Tags" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "budget" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "education" })).toBeNull();
    expect(screen.queryByText("education saved.")).toBeNull();
  });
});
