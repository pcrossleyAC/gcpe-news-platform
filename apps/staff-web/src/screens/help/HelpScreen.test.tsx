import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { GLOSSARY } from "../../shared/glossary";
import { SHORTCUTS, shortcutWords } from "../../shared/shortcuts";
import { HelpScreen } from "./HelpScreen";

function renderHelp(roles: string[], path = "/help") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/help" element={<HelpScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("HelpScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("has one h1, a title, and the four parts in its contents: Manuals, How do I, Keyboard shortcuts, Glossary", async () => {
    renderHelp(["NRMS.Editor"]);
    expect(await screen.findByRole("heading", { level: 1, name: "Help" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const contents = screen.getByRole("navigation", { name: "On this page" });
    expect(within(contents).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#manuals", "#how-do-i", "#shortcuts", "#glossary"]);
    await waitFor(() => expect(document.title).toBe("Help — GCPE News Staff"));
  });

  it("lists every shortcut from the registry the app's keys use, with the keys for this device", async () => {
    renderHelp(["NRMS.Viewer"]);
    const table = await screen.findByRole("table", { name: "Keyboard shortcuts" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(SHORTCUTS.length);
    SHORTCUTS.forEach((s, i) => {
      expect(rows[i]).toHaveTextContent(shortcutWords(s.id, false));
      expect(rows[i]).toHaveTextContent(s.does);
    });
  });

  it("has every glossary entry, each with its own anchor", async () => {
    renderHelp(["NRMS.Viewer"]);
    await screen.findByRole("heading", { level: 2, name: "Glossary" });
    for (const e of GLOSSARY) {
      const term = document.getElementById(`glossary-${e.id}`);
      expect(term).not.toBeNull();
      expect(term).toHaveTextContent(e.term);
    }
  });

  it("shows How do I pointers only for the sections the user can open", async () => {
    renderHelp(["NoD.Viewer"]);
    const howTo = (await screen.findByRole("heading", { level: 2, name: "How do I…" })).closest("section")!;
    expect(within(howTo).getByRole("heading", { level: 3, name: "Subscribers" })).toBeInTheDocument();
    expect(within(howTo).queryByRole("heading", { level: 3, name: "Releases" })).toBeNull();
    expect(within(howTo).queryByRole("heading", { level: 3, name: "Calendar" })).toBeNull();
  });

  it("shows each How do I pointer only to the roles that can do it", async () => {
    const pointers = async () => {
      const howTo = (await screen.findByRole("heading", { level: 2, name: "How do I…" })).closest("section")!;
      return [...howTo.querySelectorAll("li strong")].map((s) => s.textContent);
    };
    const EDITOR_ONLY = ["Start a release:", "Save your edits:", "Approve, publish or schedule:", "Plan a time without committing it:", "Correct a published release:"];
    const SITE_EDITOR_ONLY = ["Change the banner, footer and other site settings:", "Change the home page carousel:"];

    renderHelp(["NRMS.Viewer"]);
    const viewer = await pointers();
    expect(viewer).toContain("Find a release:");
    for (const p of [...EDITOR_ONLY, ...SITE_EDITOR_ONLY]) expect(viewer).not.toContain(p);
    cleanup();

    renderHelp(["NRMS.Editor"]);
    const editor = await pointers();
    for (const p of [...EDITOR_ONLY, "Find a release:"]) expect(editor).toContain(p);
    for (const p of SITE_EDITOR_ONLY) expect(editor).not.toContain(p);
    cleanup();

    renderHelp(["NRMS.SiteEditor"]);
    const siteEditor = await pointers();
    for (const p of SITE_EDITOR_ONLY) expect(siteEditor).toContain(p);
    for (const p of EDITOR_ONLY) expect(siteEditor).not.toContain(p);
    cleanup();

    // A Core administrator sees Website view-only, so the Website change pointers aren't theirs.
    renderHelp(["Core.Admin"]);
    const coreAdmin = await pointers();
    for (const p of SITE_EDITOR_ONLY) expect(coreAdmin).not.toContain(p);
    cleanup();
    renderHelp(["Core.Admin", "NRMS.SiteEditor"]);
    const coreSiteEditor = await pointers();
    for (const p of SITE_EDITOR_ONLY) expect(coreSiteEditor).toContain(p);
    cleanup();

    renderHelp(["NoD.Viewer"]);
    expect(await pointers()).not.toContain("Change what someone gets:");
    cleanup();
    renderHelp(["NoD.Editor"]);
    expect(await pointers()).toContain("Change what someone gets:");
    cleanup();

    const CALENDAR_CHANGE = ["Add an activity:", "Edit an activity:", "Change something during the daily change freeze:"];
    const CALENDAR_ALL = ["Narrow the list:", "Make a report:"];
    renderHelp(["Calendar.ReadOnly"]);
    const readOnly = await pointers();
    for (const p of CALENDAR_ALL) expect(readOnly).toContain(p);
    for (const p of CALENDAR_CHANGE) expect(readOnly).not.toContain(p);
    cleanup();
    renderHelp(["Calendar.Editor"]);
    const calendarEditor = await pointers();
    for (const p of [...CALENDAR_CHANGE, ...CALENDAR_ALL]) expect(calendarEditor).toContain(p);
  });

  it("says changes to the live carousel reach the public home page within a few minutes, as the carousel's own dialog does", async () => {
    renderHelp(["NRMS.SiteEditor"]);
    const pointer = (await screen.findByText("Change the home page carousel:")).closest("li")!;
    expect(pointer).toHaveTextContent("Changes to the live carousel reach the public home page within a few minutes, so it asks first.");
  });

  it("a link to one glossary entry lands on it", async () => {
    renderHelp(["Calendar.ReadOnly"], "/help#glossary-la-status");
    const term = await screen.findByText("LA Status", { selector: "dt" });
    await waitFor(() => expect(term).toHaveFocus());
  });

  it("lists the manuals for the reader's roles, own first (Review Focus 2)", async () => {
    renderHelp(["NRMS.Editor", "Calendar.ReadOnly"]);
    const manuals = (await screen.findByRole("heading", { level: 2, name: "Manuals" })).closest("section")!;
    const links = within(manuals).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Releases editor manual", "/help/manuals/nrms-editor"],
      ["Calendar read-only manual", "/help/manuals/calendar-readonly"],
      ["Releases viewer manual", "/help/manuals/nrms-viewer"],
    ]);
    expect(within(manuals).queryByText(/Site editor manual|Calendar administrator manual/)).toBeNull();
  });

  it("lists every manual for a Core administrator, Core administrator manual first", async () => {
    renderHelp(["Core.Admin"]);
    const manuals = (await screen.findByRole("heading", { level: 2, name: "Manuals" })).closest("section")!;
    const links = within(within(manuals).getByRole("list")).getAllByRole("link");
    expect(links).toHaveLength(11);
    expect(links[0]).toHaveTextContent("Core administrator manual");
    // After the manuals, outside their list: the Core administrator's review of what changed.
    expect(within(manuals).getByRole("link", { name: "Changed since your last review" })).toHaveAttribute("href", "/help/manuals-review");
  });

  it("says there are no manuals, and still shows shortcuts and glossary, for a user with no app role (Review Focus 1)", async () => {
    renderHelp(["Core.Read"]);
    const manuals = (await screen.findByRole("heading", { level: 2, name: "Manuals" })).closest("section")!;
    expect(within(manuals).getByText("No manuals for your roles yet.")).toBeInTheDocument();
    expect(within(manuals).queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Glossary" })).toBeInTheDocument();
  });

  it("has no serious/critical axe violations", async () => {
    const { container } = renderHelp(["NRMS.Editor", "NoD.Admin", "Calendar.SysAdmin", "Core.Admin"]);
    await screen.findByRole("heading", { level: 1, name: "Help" });
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
