import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { UndeliveredUpdatesScreen } from "./UndeliveredUpdatesScreen";

const RELEASE = {
  eventId: "11111111-1111-4111-8111-111111111111",
  subscriber: "nod",
  type: "release.published",
  aggregateId: "release:1",
  about: "Highway 11 traffic change",
  attempts: 9,
  lastError: "HTTP 503",
  createdAt: "2026-10-30T17:00:00.000Z",
};
const RELEASE_2 = { ...RELEASE, eventId: "22222222-2222-4222-8222-222222222222", about: "Second release", createdAt: "2026-10-30T16:00:00.000Z" };
const ORG = { ...RELEASE, eventId: "33333333-3333-4333-8333-333333333333", subscriber: "calendar", type: "org.deactivated", aggregateId: "org:health", about: "health", lastError: `fetch failed: ${"x".repeat(300)}`, createdAt: "2026-10-30T18:00:00.000Z" };

type AppList = { app: string; items: unknown[]; total: number; truncated: boolean };
const lists = (nrms: unknown[], core: unknown[] = []): AppList[] => [
  { app: "nrms", items: nrms, total: nrms.length, truncated: false },
  { app: "core", items: core, total: core.length, truncated: false },
  { app: "distribution", items: [], total: 0, truncated: false },
];

function stub(opts: { roles?: string[]; before: AppList[]; after?: AppList[] }) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let retried = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: opts.roles ?? ["Core.Admin"] }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/stack/undelivered") return jsonResponse(200, { apps: retried ? (opts.after ?? opts.before) : opts.before });
      if (url === "/stack/undelivered/retry") {
        retried = true;
        return new Response(null, { status: 204 });
      }
      if (url === "/stack/undelivered/retry-all") {
        retried = true;
        return jsonResponse(200, { retried: 2 });
      }
      throw new Error(`unhandled: ${url}`);
    }),
  );
  return calls;
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <UndeliveredUpdatesScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

// Suite review O1.3 (owner 2026-10-31).
describe("UndeliveredUpdatesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sets the document title", async () => {
    stub({ before: lists([]) });
    renderScreen();
    await screen.findByRole("heading", { name: "Undelivered updates", level: 1 });
    await waitFor(() => expect(document.title).toBe("Undelivered updates — GCPE News Staff"));
  });

  it("says so when nothing is waiting", async () => {
    stub({ before: lists([]) });
    renderScreen();
    expect(await screen.findByText("Nothing is waiting: every update was delivered.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists every app's undelivered updates newest first, in plain words", async () => {
    stub({ before: lists([RELEASE], [ORG]) });
    renderScreen();
    const table = await screen.findByRole("table", { name: /Undelivered updates, newest first/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const cells = (r: HTMLElement) => within(r).getAllByRole("cell").map((c) => c.textContent);
    // ORG is newer, so it comes first.
    expect(cells(rows[0]!).slice(1, 4)).toEqual(["Core administration", "Organization deactivated: health", "Calendar"]);
    expect(cells(rows[1]!).slice(1, 5)).toEqual(["Releases", "Release published: Highway 11 traffic change", "Subscribers (News On Demand)", "HTTP 503"]);
    // A long error is shortened.
    expect(cells(rows[0]!)[4]!.length).toBeLessThanOrEqual(121);
    expect(cells(rows[0]!)[4]!.endsWith("…")).toBe(true);
    for (const raw of ["release.published", "org.deactivated", "nrms", "nod"]) expect(screen.queryByText(raw)).toBeNull();
  });

  it("retries one row and reloads", async () => {
    const calls = stub({ before: lists([RELEASE]), after: lists([]) });
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Retry Release published: Highway 11 traffic change to Subscribers \(News On Demand\)/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Queued for delivery again.");
    expect(calls.find((c) => c.url === "/stack/undelivered/retry")?.body).toEqual({ app: "nrms", eventId: RELEASE.eventId, subscriber: "nod" });
    expect(await screen.findByText("Nothing is waiting: every update was delivered.")).toBeInTheDocument();
  });

  it("says to check the receiving app when a retried update comes back", async () => {
    stub({ before: lists([RELEASE]), after: lists([RELEASE]) });
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Retry Release published/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("If it comes back here after the next minute, the receiving app is still refusing it");
  });

  it("offers Retry all for an app with more than one, and retries them together", async () => {
    const calls = stub({ before: lists([RELEASE, RELEASE_2], [ORG]), after: lists([], [ORG]) });
    renderScreen();
    expect(await screen.findByRole("button", { name: "Retry all 2 from Releases" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry all .* from Core administration/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry all 2 from Releases" }));
    expect(await screen.findByRole("status")).toHaveTextContent("2 updates queued for delivery again.");
    expect(calls.find((c) => c.url === "/stack/undelivered/retry-all")?.body).toEqual({ app: "nrms" });
  });

  it("says when an app's list is cut short", async () => {
    stub({ before: [{ app: "nrms", items: [RELEASE], total: 350, truncated: true }] });
    renderScreen();
    expect(await screen.findByText("Releases has 350 undelivered updates: only the 200 most recent are listed.")).toBeInTheDocument();
  });

  it("a non-Core.Admin is blocked and nothing is fetched", async () => {
    const calls = stub({ roles: ["NRMS.Editor"], before: lists([RELEASE]) });
    renderScreen();
    expect(await screen.findByText("You don’t have permission to view this page.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/stack/"))).toBe(false);
  });
});
