import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { compile } from "../../../../../scripts/manuals-lib.mjs";
import { FIXTURE, fixturePage } from "../../manuals/test-fixtures";
import { ManualScreen } from "./ManualScreen";

const TABLE_MD = "---\nid: tables\ntitle: Tables\nmanual: core-admin\norder: 1\nroutes: []\nscreens: []\ntopics: []\n---\n| Screen | What it does |\n|---|---|\n| Users | Add and remove people |\n\n| Other | Thing |\n|---|---|\n| a | b |\n";
const COMPILED = compile([{ path: "t.md", text: TABLE_MD }], null, "2026-10-30").pages[0]!;
const TABLE_DATA = { pages: [fixturePage({ ...COMPILED, id: "tables" })] };

function renderManual(roles: string[], path: string, data = FIXTURE) {
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
            <Route path="/help/manuals/:manualId" element={<ManualScreen data={data} />} />
            <Route path="/help/manuals/:manualId/:pageId" element={<ManualScreen data={data} />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

const NOT_AVAILABLE = "This manual isn't available for your role.";

describe("ManualScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists a manual's pages in order, with who it is for", async () => {
    renderManual(["NRMS.Editor"], "/help/manuals/nrms-editor");
    expect(await screen.findByRole("heading", { level: 1, name: "Releases editor manual" })).toBeInTheDocument();
    expect(screen.getByText(/Release editors/)).toBeInTheDocument();
    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Writing a release", "/help/manuals/nrms-editor/editor-releases"],
      ["Publishing", "/help/manuals/nrms-editor/editor-publishing"],
    ]);
  });

  it("shows a page: its title, its contents, who it is for and a long 'Last changed' date", async () => {
    renderManual(["Core.Admin"], "/help/manuals/core-admin/government-terms");
    expect(await screen.findByRole("heading", { level: 1, name: "Government terms" })).toBeInTheDocument();
    expect(screen.getByText("Body of government-terms.")).toBeInTheDocument();
    expect(screen.getByText("Last changed October 5, 2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Core administrator manual" })).toHaveAttribute("href", "/help/manuals/core-admin");
  });

  it("shows the page's own 'Who this is for' line", async () => {
    renderManual(["Core.Admin"], "/help/manuals/core-admin/core-admin-overview");
    expect(await screen.findByText(/Who this is for:/)).toBeInTheDocument();
  });

  it("opens an in-page link inside the Hub, without a reload", async () => {
    renderManual(["NRMS.Editor"], "/help/manuals/nrms-editor/editor-releases");
    fireEvent.click(await screen.findByRole("link", { name: "publishing" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Publishing" })).toBeInTheDocument();
  });

  it("shows a topic page to a reader who can see a page that lists it, and links to it", async () => {
    renderManual(["NRMS.Editor"], "/help/manuals/topic/signing-in");
    expect(await screen.findByRole("heading", { level: 1, name: "Signing in" })).toBeInTheDocument();
    expect(screen.getByText("Use your IDIR.")).toBeInTheDocument();
  });

  it.each([
    ["a manual above the reader's role", ["NRMS.Editor"], "/help/manuals/nrms-site-editor"],
    ["a page in a manual above the reader's role", ["NRMS.Editor"], "/help/manuals/nrms-site-editor/site-editor-releases"],
    ["a manual in an app the reader has no role in", ["NRMS.Editor"], "/help/manuals/calendar-admin"],
    ["a topic page no visible page lists", ["NRMS.Editor"], "/help/manuals/topic/site-editor-only-topic"],
    ["a page under the wrong manual", ["NRMS.Editor"], "/help/manuals/nrms-viewer/editor-releases"],
    ["a page that doesn't exist", ["Core.Admin"], "/help/manuals/core-admin/nope"],
    ["a manual that doesn't exist", ["Core.Admin"], "/help/manuals/nope"],
    ["any manual, for a reader with no role", [], "/help/manuals/nrms-viewer"],
    ["the topic path with no page", ["Core.Admin"], "/help/manuals/topic"],
  ])("says it isn't available, with no content, for %s", async (_name, roles, path) => {
    const { container } = renderManual(roles, path);
    expect(await screen.findByText(NOT_AVAILABLE)).toBeInTheDocument();
    expect(container.querySelector(".gcpe-manual__content")).toBeNull();
    expect(container.textContent).not.toMatch(/Body of|Secret|Use your IDIR/);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("keeps a manual's tables as tables inside labelled scroll boxes, with no axe violations of any impact", async () => {
    const { container } = renderManual(["Core.Admin"], "/help/manuals/core-admin/tables", TABLE_DATA);
    await screen.findByRole("heading", { level: 1, name: "Tables" });
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Table 1 — scrollable" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("columnheader", { name: "Screen" })).toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it.each([
    ["a manual contents page", "/help/manuals/nrms-editor"],
    ["a manual page", "/help/manuals/nrms-editor/editor-releases"],
    ["not available", "/help/manuals/nrms-site-editor"],
  ])("has no serious/critical axe violations on %s", async (_name, path) => {
    const { container } = renderManual(["NRMS.Editor"], path);
    await screen.findByRole("heading", { level: 1 });
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
