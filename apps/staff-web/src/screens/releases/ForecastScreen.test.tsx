import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ForecastItem, ForecastPage, ReleaseListItem } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
import { ForecastScreen } from "./ForecastScreen";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const release = (over: Partial<ReleaseListItem> = {}): ReleaseListItem => ({
  id: "11111111-1111-1111-1111-111111111111", type: "release", key: null, reference: "NEWS-00001", status: "scheduled", statusText: "Scheduled",
  leadOrganization: "Health", pageTitle: "News Release", headline: "Sample scheduled release", location: "VICTORIA", summary: "A summary.",
  publishAt: "2031-06-10T17:00:00.000Z", releasedAt: null, activityId: 4101, approved: true, flickrAlert: null, lastEdited: null, ...over,
});
const ITEMS: ForecastItem[] = [
  { kind: "release", at: "2031-06-10T17:00:00.000Z", release: release() },
  {
    kind: "activity", at: "2031-06-11T17:00:00.000Z",
    activity: { activityId: 4102, title: "Sample clinic opening", details: "Sample details.", ministryName: "Health", categoryNames: ["Approved Event"], location: "Victoria" },
  },
];
const page = (over: Partial<ForecastPage> = {}): ForecastPage => ({ items: ITEMS, total: 2, page: 1, pageSize: 25, calendarActivities: true, ...over });

function renderForecast(opts: { roles?: string[]; forecast?: ForecastPage | "error"; path?: string; forecastFailure?: { status: number; body: unknown } } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: opts.roles ?? ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url.startsWith("/nrms/api/forecast")) {
        if (opts.forecastFailure) return jsonResponse(opts.forecastFailure.status, opts.forecastFailure.body);
        return opts.forecast === "error" ? jsonResponse(500, { error: "internal error" }) : jsonResponse(200, opts.forecast ?? page());
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  const result = render(
    <SessionProvider>
      <MemoryRouter initialEntries={[opts.path ?? "/releases/forecast"]}>
        <Routes>
          <Route path="/releases/forecast" element={<ForecastScreen />} />
          <Route path="/releases/new" element={<p>New release screen</p>} />
          <Route path="/calendar/activities/:id" element={<p>Activity screen</p>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  return { calls, ...result };
}

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("ForecastScreen (spec addendum §11; Releases.aspx's Forecast folder)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("lists releases and Calendar activities in the server's order; an activity reads \"Planned for\" with its id, location and ministry", async () => {
    const { calls } = renderForecast();
    const rows = within((await screen.findByText("Sample scheduled release")).closest("ul")!).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("link", { name: /Sample/ }).textContent)).toEqual(["Sample scheduled release", "Victoria - Sample clinic opening"]);
    expect(rows[1]).toHaveTextContent("Calendar activity · Health");
    expect(rows[1]).toHaveTextContent("Approved Event");
    expect(rows[1]).toHaveTextContent("Planned for Jun 11, 2031 10:00 AM · Calendar activity ID 4102");
    expect(within(rows[1]!).getByRole("link", { name: "Victoria - Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(calls).toContain("/nrms/api/forecast?page=1");
    expect(screen.getByRole("heading", { level: 1, name: "Forecast" })).toBeInTheDocument();
  });

  // Suite review R8: a planned release stays listed for the rest of its day after its time passes
  // (the server keeps it); the row says its planned time has passed.
  it("a planned release whose time has passed says so", async () => {
    const passed = release({ status: "approved", statusText: "Planned", publishAt: new Date(Date.now() - 3600_000).toISOString(), headline: "Planned, not scheduled" });
    renderForecast({ forecast: page({ items: [{ kind: "release", at: passed.publishAt!, release: passed }], total: 1 }) });
    expect(await screen.findByText("Planned time passed – not published")).toBeInTheDocument();
  });

  it("an Editor can start a release from an activity; a Viewer can't", async () => {
    renderForecast({ roles: ["NRMS.Viewer"] });
    await screen.findByText("Victoria - Sample clinic opening");
    expect(screen.queryByRole("link", { name: "Start a release" })).toBeNull();
    cleanup();
    renderForecast({ roles: ["NRMS.Editor"] });
    const start = await screen.findByRole("link", { name: "Start a release" });
    expect(start).toHaveAttribute("href", "/releases/new?activity=4102");
    await userEvent.setup().click(start);
    expect(await screen.findByText("New release screen")).toBeInTheDocument();
  });

  it("without Calendar access, says why only releases are listed", async () => {
    renderForecast({ forecast: page({ items: [ITEMS[0]!], total: 1, calendarActivities: false }) });
    expect(await screen.findByText("Calendar activities are listed here for people with Calendar access. Ask a Calendar administrator if you need it.")).toBeInTheDocument();
  });

  it("asks for the page in the address, and pages on", async () => {
    const { calls } = renderForecast({ path: "/releases/forecast?page=2", forecast: page({ total: 40, page: 2 }) });
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();
    expect(calls).toContain("/nrms/api/forecast?page=2");
  });

  it("says when nothing is planned, and when the Forecast couldn't load", async () => {
    renderForecast({ forecast: page({ items: [], total: 0 }) });
    expect(await screen.findByText("Nothing is planned from now on.")).toBeInTheDocument();
    cleanup();
    renderForecast({ forecast: "error" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the Forecast.");
  });

  it("shows a 400, 403 or 404's own server message instead of the generic one", async () => {
    renderForecast({ forecastFailure: { status: 403, body: { error: "forbidden" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("forbidden");
    cleanup();
    renderForecast({ forecastFailure: { status: 404, body: { error: "not found" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("not found");
    cleanup();
    renderForecast({ forecastFailure: { status: 400, body: { error: "invalid request" } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid request");
  });

  it("the folder tabs lead with Forecast, as legacy's menu did", async () => {
    renderForecast();
    const tabs = within(await screen.findByRole("navigation", { name: "Release folders" })).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual(["Forecast", "Drafts", "Scheduled", "Published"]);
  });

  it("puts the folder tabs above the h1, as every section does", async () => {
    renderForecast();
    const tabs = await screen.findByRole("navigation", { name: "Release folders" });
    const h1 = screen.getByRole("heading", { level: 1, name: "Forecast" });
    expect(tabs.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no serious or critical axe violations: listed, Editor, no Calendar access, empty, failed", async () => {
    for (const opts of [{}, { roles: ["NRMS.Editor"] }, { forecast: page({ items: [ITEMS[0]!], total: 1, calendarActivities: false }) }, { forecast: page({ items: [], total: 0 }) }, { forecast: "error" as const }]) {
      const { container } = renderForecast(opts);
      await screen.findByRole("heading", { level: 1, name: "Forecast" });
      await screen.findByText(/Sample scheduled release|Nothing is planned|Couldn't load/);
      expect(await seriousViolations(container)).toEqual([]);
      cleanup();
    }
  });
});
