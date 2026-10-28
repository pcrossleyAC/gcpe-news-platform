import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { GONE_IMAGE, PageTypesFixture, PAGE_IMAGES } from "./fixtures";
import { PageTitlesScreen } from "./PageTitlesScreen";

type Call = { url: string; method: string; body: any };
function stub(roles: string[], handlers: { write?: (c: Call) => Response } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const call = { url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nrms/api/page-types" && method === "GET") return jsonResponse(200, PageTypesFixture);
    if (url === "/nrms/api/page-images") return jsonResponse(200, PAGE_IMAGES);
    if (url.startsWith("/nrms/api/page-types")) {
      if (method === "DELETE") return handlers.write?.(call) ?? new Response(null, { status: 204 });
      return handlers.write?.(call) ?? jsonResponse(method === "POST" ? 201 : 200, call.body);
    }
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const listLoads = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.url === "/nrms/api/page-types").length;
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/release-page-titles"]}>
        <RequireAuth>
          <Routes>
            <Route path="/release-page-titles" element={<PageTitlesScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("PageTitlesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists the page titles grouped under Release, Story, Factsheet, Update and Advisory headings", async () => {
    stub(["Core.Admin"]);
    renderIt();
    expect(await screen.findByRole("heading", { level: 1, name: "Release page titles" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Release page titles" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 5)).toEqual(["Release", "Story", "Factsheet", "Update", "Advisory"]);
    expect(within(screen.getByRole("table", { name: "Release page titles" })).getAllByRole("row")).toHaveLength(1 + 3);
    expect(screen.getByRole("textbox", { name: "Page title for Information Bulletin" })).toHaveValue("Information Bulletin");
    expect(screen.getByText(/A release keeps the title it was given/)).toBeInTheDocument();
  });

  it("renaming a row sends PUT /nrms/api/page-types/4105/<encoded old title> with the new title and reloads", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const field = await screen.findByRole("textbox", { name: "Page title for Information Bulletin" });
    const user = userEvent.setup();
    await user.clear(field);
    await user.type(field, "Info Bulletin / Special");
    const before = listLoads(calls);
    await user.click(screen.getByRole("button", { name: "Save Information Bulletin" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: "PUT",
      url: "/nrms/api/page-types/4105/Information%20Bulletin",
      body: { pageTitle: "Info Bulletin / Special", languageId: 4105, releaseType: "release", sortOrder: 2, layout: "formal", pageImageId: null },
    });
    await waitFor(() => expect(listLoads(calls)).toBe(before + 1));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Info Bulletin / Special.");
  });

  it("a blank title or an out-of-range Order is refused before any request, with the message announced and the field focused", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: "Page title for News Release" });
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save News Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Page title is required.");
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription("Page title is required.");
    await user.type(field, "News Release");
    const order = screen.getByRole("spinbutton", { name: "Order for News Release" });
    await user.clear(order);
    await user.type(order, "10000");
    await user.click(screen.getByRole("button", { name: "Save News Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Order must be a whole number from 0 to 9999.");
    expect(order).toHaveFocus();
    expect(writes(calls)).toHaveLength(0);
  });

  it("Delete asks first; confirming sends DELETE; a 409 'only English page title' message shows on that row", async () => {
    const message = "This is the only English page title for Story. Add another first.";
    const calls = stub(["Core.Admin"], { write: () => jsonResponse(409, { error: message }) });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Story" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete Story?")).toBeInTheDocument();
    expect(within(dialog).getByText("New releases can no longer choose it. Releases that already use it keep it.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(writes(calls)).toEqual([{ url: "/nrms/api/page-types/4105/Story", method: "DELETE", body: undefined }]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const row = screen.getByRole("textbox", { name: "Page title for Story" }).closest("tr")!;
    expect(within(row).getByRole("alert")).toHaveTextContent(message);
  });

  it("cancelling the Delete confirmation sends nothing", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Story" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(writes(calls)).toHaveLength(0);
  });

  it("a confirmed delete reloads the list", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Information Bulletin" }));
    const before = listLoads(calls);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(listLoads(calls)).toBe(before + 1));
    expect(await screen.findByRole("status")).toHaveTextContent("Deleted Information Bulletin.");
  });

  it("Add a page title defaults Order to the type's highest + 1 and sends POST", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "Release page titles" });
    const form = await screen.findByRole("form", { name: "Add a page title" });
    const f = within(form);
    expect(f.getByRole("combobox", { name: "Language" })).toHaveValue("4105");
    expect(f.getByRole("combobox", { name: "Layout" })).toHaveValue("formal");
    expect(f.getByRole("combobox", { name: "Page image" })).toHaveValue("");
    expect(f.getByRole("combobox", { name: "Type" })).toHaveValue("release");
    expect(f.getByRole("spinbutton", { name: "Order" })).toHaveValue(7); // highest Release order is 6
    await user.selectOptions(f.getByRole("combobox", { name: "Type" }), "story");
    expect(f.getByRole("spinbutton", { name: "Order" })).toHaveValue(2);
    await user.selectOptions(f.getByRole("combobox", { name: "Type" }), "release");
    await user.type(f.getByRole("textbox", { name: "Page title" }), "  Media Statement ");
    await user.selectOptions(f.getByRole("combobox", { name: "Page image" }), PAGE_IMAGES[0]!.id);
    await user.click(f.getByRole("button", { name: "Add page title" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: "POST",
      url: "/nrms/api/page-types",
      body: { pageTitle: "Media Statement", languageId: 4105, releaseType: "release", sortOrder: 7, layout: "formal", pageImageId: PAGE_IMAGES[0]!.id },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Added Media Statement.");
  });

  it("submitting twice while an Add is saving sends one POST", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = stub(["Core.Admin"]);
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
      if (i?.method === "POST") {
        calls.push({ url: u, method: "POST", body: JSON.parse(String(i.body)) });
        await gate;
        return jsonResponse(201, {});
      }
      return inner(u, i);
    }));
    renderIt();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "Release page titles" });
    const form = await screen.findByRole("form", { name: "Add a page title" });
    const title = within(form).getByRole("textbox", { name: "Page title" });
    await user.type(title, "Media Statement");
    // Submit events reach onSubmit directly (Enter, assistive tech), whatever the button looks like.
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    await waitFor(() => expect(within(form).getByRole("textbox", { name: "Page title" })).toHaveValue(""));
    expect(writes(calls)).toHaveLength(1);
  });

  it("a 409 duplicate on Add shows in the form's alert and keeps what was typed", async () => {
    stub(["Core.Admin"], { write: () => jsonResponse(409, { error: "A page title with that name already exists in that language." }) });
    renderIt();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "Release page titles" });
    const form = await screen.findByRole("form", { name: "Add a page title" });
    await user.type(within(form).getByRole("textbox", { name: "Page title" }), "News Release");
    await user.click(within(form).getByRole("button", { name: "Add page title" }));
    const msg = "A page title with that name already exists in that language.";
    expect(await within(form.parentElement!).findByRole("alert")).toHaveTextContent(msg);
    expect(within(form).getByRole("textbox", { name: "Page title" })).toHaveAccessibleDescription(msg);
    expect(within(form).getByRole("textbox", { name: "Page title" })).toHaveValue("News Release");
  });

  it("a row Save pressed twice quickly sends one request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = stub(["Core.Admin"]);
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
      if (i?.method === "PUT") await gate;
      return inner(u, i);
    }));
    renderIt();
    const user = userEvent.setup();
    const save = await screen.findByRole("button", { name: "Save Story" });
    await user.dblClick(save);
    release();
    await screen.findByRole("status");
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
  });

  it("after a confirmed delete, focus lands on the status line", async () => {
    stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Information Bulletin" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    const status = await screen.findByText("Deleted Information Bulletin.");
    await waitFor(() => expect(status).toHaveFocus());
  });

  it("a delete 409 moves focus to that row's alert once the dialog has closed", async () => {
    stub(["Core.Admin"], { write: () => jsonResponse(409, { error: "Only one left." }) });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Story" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    const row = (await screen.findByRole("textbox", { name: "Page title for Story" })).closest("tr")!;
    await waitFor(() => expect(within(row).getByRole("alert")).toBeInTheDocument());
    await waitFor(() => expect(row.contains(document.activeElement) && document.activeElement?.contains(within(row).getByRole("alert"))).toBe(true));
  });

  it("a row Save 409 focuses the row's title field and describes it with the message", async () => {
    stub(["Core.Admin"], { write: () => jsonResponse(409, { error: "A page title with that name already exists in that language." }) });
    renderIt();
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: "Page title for News Release" });
    await user.click(screen.getByRole("button", { name: "Save News Release" }));
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAccessibleDescription("A page title with that name already exists in that language.");
  });

  it("a 404 says the title no longer exists and reloads; a 403 says you lack permission", async () => {
    let status = 404;
    const calls = stub(["Core.Admin"], { write: () => jsonResponse(status, { error: "not found" }) });
    renderIt();
    const user = userEvent.setup();
    const saveStory = await screen.findByRole("button", { name: "Save Story" });
    const before = listLoads(calls);
    await user.click(saveStory);
    expect(await screen.findByRole("alert")).toHaveTextContent("That page title no longer exists.");
    await waitFor(() => expect(listLoads(calls)).toBe(before + 1));
    status = 403;
    await user.click(screen.getByRole("button", { name: "Save Story" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You don't have permission to change page titles."));
  });

  it("a row whose page image is no longer active keeps it as a selectable option", async () => {
    stub(["Core.Admin"]);
    renderIt();
    const select = await screen.findByRole("combobox", { name: "Page image for Story" });
    expect(select).toHaveValue(GONE_IMAGE);
    expect(within(select).getByRole("option", { name: "Current image (no longer available)" })).toBeInTheDocument();
  });

  it("a status message is cleared when a later action fails", async () => {
    let fail = false;
    stub(["Core.Admin"], { write: (c) => (fail ? jsonResponse(409, { error: "Nope." }) : jsonResponse(200, c.body)) });
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save Story" }));
    expect(await screen.findByText("Saved Story.")).toBeInTheDocument();
    fail = true;
    await user.click(screen.getByRole("button", { name: "Save Story" }));
    await waitFor(() => expect(screen.queryByText("Saved Story.")).toBeNull());
  });

  it("after a rename a second Save targets the new title", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const field = await screen.findByRole("textbox", { name: "Page title for Story" });
    await user.clear(field);
    await user.type(field, "  Tale  ");
    await user.click(screen.getByRole("button", { name: "Save Story" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body.pageTitle).toBe("Tale");
  });

  it("a non-Core.Admin sees the permission message", async () => {
    const calls = stub(["NRMS.SiteEditor"]);
    renderIt();
    expect(await screen.findByText("You don't have permission to manage release page titles.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/nrms/api/page-types"))).toBe(false);
    await waitFor(() => expect(document.title).toBe("Release page titles — GCPE News Staff"));
  });
});
