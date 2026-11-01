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
  replaced: false,
};
const RELEASE_2 = { ...RELEASE, eventId: "22222222-2222-4222-8222-222222222222", about: "Second release", createdAt: "2026-10-30T16:00:00.000Z" };
const ORG = { ...RELEASE, eventId: "33333333-3333-4333-8333-333333333333", subscriber: "calendar", type: "org.deactivated", aggregateId: "org:health", about: "health", lastError: `fetch failed: ${"x".repeat(300)}`, createdAt: "2026-10-30T18:00:00.000Z" };
const REPLACED = { ...RELEASE, eventId: "44444444-4444-4444-8444-444444444444", about: "Withdrawn release", createdAt: "2026-10-30T15:00:00.000Z", replaced: true };

type Item = typeof RELEASE;
type AppList = { app: string; items: Item[]; total: number; replaced: number; truncated: boolean };
const list = (app: string, items: Item[]): AppList => ({ app, items, total: items.length, replaced: items.filter((i) => i.replaced).length, truncated: false });
const lists = (nrms: Item[], core: Item[] = []): AppList[] => [list("nrms", nrms), list("core", core), list("distribution", [])];

const DISMISSAL = { app: "core", eventId: "55555555-5555-4555-8555-555555555555", subscriber: "nrms", type: "org.upserted", about: "finance", lastError: "HTTP 400", createdAt: "2026-10-29T10:00:00.000Z", replaced: false, dismissedAt: "2026-10-31T09:00:00.000Z", dismissedBy: "Sam Admin" };

type Reply = { status: number; body?: unknown };
function stub(opts: { roles?: string[]; before: AppList[]; after?: AppList[]; dismissed?: unknown[]; replies?: Record<string, Reply> }) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let acted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles: opts.roles ?? ["Core.Admin"] }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/stack/undelivered") return jsonResponse(200, { apps: acted ? (opts.after ?? opts.before) : opts.before, dismissed: opts.dismissed ?? [] });
      const reply = opts.replies?.[url];
      if (url.startsWith("/stack/undelivered/")) {
        acted = true;
        if (reply) return reply.body === undefined ? new Response(null, { status: reply.status }) : jsonResponse(reply.status, reply.body);
        if (url.endsWith("/retry-all")) return jsonResponse(200, { retried: 2, replaced: 0 });
        if (url.endsWith("/dismiss-all")) return jsonResponse(200, { dismissed: 3 });
        return new Response(null, { status: 204 });
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

const statusLine = () => screen.getByRole("status");

// Suite review O1.3 (owner 2026-10-31), fix round 1 (controller rulings 2026-11-01).
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

  it("says so when nothing is waiting, with its status line already in place", async () => {
    stub({ before: lists([]) });
    renderScreen();
    expect(await screen.findByText("Nothing is waiting: every update was delivered.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    // Fix round 1, N2: mounted before anything is said in it, so what it says is announced.
    expect(statusLine()).toBeEmptyDOMElement();
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

  it("retries one row, reloads, and puts focus on what happened", async () => {
    const calls = stub({ before: lists([RELEASE]), after: lists([]) });
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Retry Release published: Highway 11 traffic change to Subscribers \(News On Demand\)/ }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("Queued for delivery again."));
    expect(calls.find((c) => c.url === "/stack/undelivered/retry")?.body).toEqual({ app: "nrms", eventId: RELEASE.eventId, subscriber: "nod" });
    expect(await screen.findByText("Nothing is waiting: every update was delivered.")).toBeInTheDocument();
    await waitFor(() => expect(statusLine()).toHaveFocus());
  });

  it("says to check the receiving app when a retried update comes back", async () => {
    stub({ before: lists([RELEASE]), after: lists([RELEASE]) });
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Retry Release published/ }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("If it comes back here after the next minute, the receiving app is still refusing it"));
  });

  // Fix round 1, I1.
  it("shows a replaced update as replaced, with no Retry", async () => {
    stub({ before: lists([RELEASE, REPLACED]) });
    renderScreen();
    const row = (await screen.findByText("Release published: Withdrawn release")).closest("tr")!;
    expect(within(row).getByText("Replaced by a newer update: not sent again")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^Retry/ })).toBeNull();
    expect(within(row).getByRole("button", { name: /^Dismiss Release published: Withdrawn release/ })).toBeInTheDocument();
  });

  it("shows the server's reason when a retry is refused because a newer update replaced it", async () => {
    stub({ before: lists([RELEASE]), replies: { "/stack/undelivered/retry": { status: 409, body: { error: "A newer update replaced this one, so it isn't sent again." } } } });
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Retry Release published/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A newer update replaced this one, so it isn't sent again.");
  });

  it("asks before Retry all, saying how many are resent, that replaced ones aren't, and that subscribers are emailed", async () => {
    const calls = stub({ before: lists([RELEASE, RELEASE_2, REPLACED], [ORG]), after: lists([REPLACED], [ORG]) });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Retry all 2 from Releases" }));
    expect(screen.queryByRole("button", { name: /Retry all .* from Core administration/ })).toBeNull();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Resend 2 updates from Releases?");
    expect(dialog).toHaveTextContent("1 replaced by a newer update isn't sent.");
    expect(dialog).toHaveTextContent("A Release published update emails its subscribers when it’s sent.");
    expect(calls.some((c) => c.url === "/stack/undelivered/retry-all")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("2 updates queued for delivery again."));
    expect(calls.find((c) => c.url === "/stack/undelivered/retry-all")?.body).toEqual({ app: "nrms" });
  });

  it("Cancel on the Retry all question sends nothing", async () => {
    const calls = stub({ before: lists([RELEASE, RELEASE_2]) });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Retry all 2 from Releases" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.url === "/stack/undelivered/retry-all")).toBe(false);
  });

  // Fix round 1, M1.
  it("dismisses one row", async () => {
    const calls = stub({ before: lists([RELEASE]), after: lists([]) });
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: /^Dismiss Release published: Highway 11 traffic change/ }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("Dismissed: it won't be sent."));
    expect(calls.find((c) => c.url === "/stack/undelivered/dismiss")?.body).toEqual({ app: "nrms", eventId: RELEASE.eventId, subscriber: "nod" });
  });

  it("asks before Dismiss all, then dismisses every one listed", async () => {
    const calls = stub({ before: lists([RELEASE, RELEASE_2], [ORG]), after: lists([]) });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dismiss all 3" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Dismiss all 3 undelivered updates?");
    expect(dialog).toHaveTextContent("None of them will be sent.");
    await user.click(within(dialog).getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(statusLine()).toHaveTextContent("3 updates dismissed: they won't be sent."));
    expect(calls.find((c) => c.url === "/stack/undelivered/dismiss-all")?.body).toEqual({});
  });

  it("lists recent dismissals with who dismissed each", async () => {
    stub({ before: lists([]), dismissed: [DISMISSAL] });
    renderScreen();
    const table = await screen.findByRole("table", { name: "Dismissed updates, most recent first" });
    const cells = within(within(table).getAllByRole("row")[1]!).getAllByRole("cell").map((c) => c.textContent);
    expect(cells.slice(1)).toEqual(["Sam Admin", "Core administration", "Organization changed: finance", "Releases"]);
  });

  it("says when an app's list is cut short", async () => {
    stub({ before: [{ app: "nrms", items: [RELEASE], total: 350, replaced: 0, truncated: true }] });
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
