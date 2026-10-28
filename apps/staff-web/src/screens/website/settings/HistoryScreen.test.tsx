import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { defaultSiteSettings, type SiteSettings } from "@gcpe/site-settings";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { AnnouncerProvider } from "../../../shared/Announcer";
import { HistoryScreen } from "./HistoryScreen";
import type { HistoryList, LiveInfo, RevisionDetail } from "./api";

const DOC: SiteSettings = defaultSiteSettings({
  colors: { primary: "#013366", primaryText: "#FFFFFF", accent: "#FCBA19", text: "#2D2D2D", mutedText: "#474543", surface: "#FFFFFF", background: "#FFFFFF", border: "#D8D8D8" },
  footerLinks: [],
});

const info = (revision: number, publishedBy: string, note: string | null, publishedAt: string): LiveInfo => ({ revision, publishedBy, note, publishedAt });
const HISTORY: HistoryList = {
  live: 3,
  revisions: [
    // 2026-10-27T01:30Z is Oct 26, 6:30 PM in BC (PDT), so the day differs from UTC.
    info(3, "Sam", "Spring colours", "2026-10-27T01:30:00.000Z"),
    info(2, "Alex", null, "2026-10-20T17:30:00.000Z"),
    info(1, "Pat", "First", "2026-10-10T17:30:00.000Z"),
  ],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(roles: string[], opts: { detail?: RevisionDetail; restore?: () => Response; history?: HistoryList } = {}) {
  const calls: Call[] = [];
  const detail: RevisionDetail = opts.detail ?? { info: HISTORY.revisions[2]!, document: DOC, differing: ["banner"] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url === "/nrms/api/site/settings/history") return jsonResponse(200, opts.history ?? HISTORY);
      if (url.startsWith("/nrms/api/site/settings/history/")) return jsonResponse(200, detail);
      if (url === "/nrms/api/site/settings/restore") return opts.restore ? opts.restore() : jsonResponse(200, { revision: 4 });
      throw new Error(`unhandled: ${call.method} ${url}`);
    }),
  );
  return calls;
}

function renderScreen() {
  return render(
    <AnnouncerProvider>
      <SessionProvider>
        <MemoryRouter>
          <RequireAuth>
            <HistoryScreen />
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>
    </AnnouncerProvider>,
  );
}

describe("HistoryScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists revisions newest first with Revision, When (BC time), Who and Note; Live on the live one, Restore… on the others", async () => {
    stub(["NRMS.SiteEditor"]);
    renderScreen();
    await screen.findByRole("heading", { name: "Settings history", level: 1 });
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Live")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Oct 26, 2026, 6:30 PM")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Sam")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Spring colours")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(within(rows[1]!).getByRole("button", { name: "Restore… revision 2" })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("button", { name: "Restore… revision 1" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Revision", "When", "Who", "Note", "Actions"]);
    await waitFor(() => expect(document.title).toBe("Settings history — GCPE News Staff"));
  });

  it("Restore… asks 'Restore revision 1?', names what changes, and confirming posts the live revision as the base", async () => {
    const calls = stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restore… revision 1" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Restore revision 1?")).toBeInTheDocument();
    expect(within(dialog).getByText("Compared with what is live now, this changes: Banner.")).toBeInTheDocument();
    expect(within(dialog).getByText("The banner would be: Off.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Restore revision 1" }));
    expect(await screen.findByText("Revision 1 is live again, as revision 4.")).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/restore"))!.body).toEqual({ revision: 1, baseRevision: 3 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the banner as it would be when it is on", async () => {
    const doc: SiteSettings = { ...DOC, banner: { ...DOC.banner, enabled: true, style: "emergency", message: "Wildfire near town" } };
    stub(["NRMS.SiteEditor"], { detail: { info: HISTORY.revisions[2]!, document: doc, differing: ["banner", "theme"] } });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restore… revision 1" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Compared with what is live now, this changes: Banner and Theme.")).toBeInTheDocument();
    expect(within(dialog).getByText("The banner would be: Emergency, “Wildfire near town”.")).toBeInTheDocument();
  });

  it("says so when the revision is identical to what is live", async () => {
    stub(["NRMS.SiteEditor"], { detail: { info: HISTORY.revisions[1]!, document: DOC, differing: [] } });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restore… revision 2" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Revision 2 is identical to what is live now. Restoring it publishes the same settings again as a new revision.")).toBeInTheDocument();
  });

  it("a 409 says nothing was restored and shows the newer live revision", async () => {
    const live = info(5, "Kim", null, "2026-10-27T20:00:00.000Z");
    const calls = stub(["NRMS.SiteEditor"], {
      restore: () => jsonResponse(409, { error: "published", code: "published", live, differing: ["banner"] }),
    });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restore… revision 1" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Restore revision 1?" })).getByRole("button", { name: "Restore revision 1" }));
    expect(await screen.findByText("Nothing was restored: revision 5 was published while you were looking. Check it and try again.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/history")).length).toBeGreaterThanOrEqual(2); // reloaded
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel closes the confirmation without a request", async () => {
    const calls = stub(["NRMS.SiteEditor"]);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restore… revision 1" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Restore revision 1?" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.url.endsWith("/restore"))).toBe(false);
  });

  it("Core.Admin alone can read the history but not restore", async () => {
    stub(["Core.Admin"]);
    renderScreen();
    expect(await screen.findByText("Spring colours")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  it("says when nothing has been published", async () => {
    stub(["NRMS.SiteEditor"], { history: { live: null, revisions: [] } });
    renderScreen();
    expect(await screen.findByText("Nothing has been published yet; the site uses its built-in defaults.")).toBeInTheDocument();
  });
});
