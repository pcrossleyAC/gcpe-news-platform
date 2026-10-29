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

  it("has one h1, a title, and the three parts in its contents: How do I, Keyboard shortcuts, Glossary", async () => {
    renderHelp(["NRMS.Editor"]);
    expect(await screen.findByRole("heading", { level: 1, name: "Help" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const contents = screen.getByRole("navigation", { name: "On this page" });
    expect(within(contents).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#how-do-i", "#shortcuts", "#glossary"]);
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

  it("a link to one glossary entry lands on it", async () => {
    renderHelp(["Calendar.ReadOnly"], "/help#glossary-la-status");
    const term = await screen.findByText("LA Status", { selector: "dt" });
    await waitFor(() => expect(term).toHaveFocus());
  });

  it("has no serious/critical axe violations", async () => {
    const { container } = renderHelp(["NRMS.Editor", "NoD.Admin", "Calendar.SysAdmin", "Core.Admin"]);
    await screen.findByRole("heading", { level: 1, name: "Help" });
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
