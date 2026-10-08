/** axe checks for the Subscribers section: every screen stays free of serious/critical
 * WCAG 2a/2aa violations, including with a confirm dialog open. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscribersScreen } from "./SubscribersScreen";
import { AddSubscriberScreen } from "./AddSubscriberScreen";
import { SubscriberScreen } from "./SubscriberScreen";
import { HistoryScreen } from "./HistoryScreen";
import { MediaListsScreen } from "./MediaListsScreen";
import { MediaListScreen } from "./MediaListScreen";
import { OperationsScreen } from "./OperationsScreen";
import { ListsScreen } from "./ListsScreen";
import type { MediaMember, OperationsStatus, StaffListsView, SubscriberDetail, SubscriberPage } from "./types";

async function seriousViolations(container: Element, options?: Parameters<typeof axe.run>[1]) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, ...options });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

const PAGE: SubscriberPage = {
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    { id: "11111111-1111-1111-1111-111111111111", email: "pat@example.test", status: "active", source: "self", asItHappens: true, digest: false, createdAt: "2026-10-01T17:00:00.000Z", needsAttention: null },
    { id: "22222222-2222-2222-2222-222222222222", email: "lee@example.test", status: "disabled", source: "admin", asItHappens: false, digest: true, createdAt: "2026-10-02T17:00:00.000Z", needsAttention: null },
  ],
};
const OPTIONS = { categories: [{ key: "ministries", name: "Ministries", lists: [{ listKey: "ministries:health", name: "Health" }] }] };

const SUBSCRIBER_ID = "11111111-1111-1111-1111-111111111111";
const DETAIL: SubscriberDetail = {
  id: SUBSCRIBER_ID,
  email: "pat@example.test",
  status: "active",
  source: "self",
  asItHappens: true,
  digest: false,
  createdAt: "2026-09-01T17:00:00.000Z",
  needsAttention: null,
  verifiedAt: "2026-09-01T17:05:00.000Z",
  endedAt: null,
  attentionAt: null,
  allNews: false,
  listKeys: ["ministries:health"],
  mediaLists: [],
  mediaHubLinked: false,
  disabledReason: null,
  bouncedEmails: 0,
  bounceWindowDays: 15,
};
const HISTORY = {
  items: [
    { at: "2026-10-02T17:00:00.000Z", actor: "Jamie Staff", action: "staff-activated", detail: "" },
    { at: "2026-10-01T17:00:00.000Z", actor: "subscriber", action: "subscribed", detail: "ministries:health" },
  ],
};

const MEDIA_LISTS = [
  { listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 2, needsAttention: 2 },
  { listKey: "media-distribution-lists:old", key: "old", name: "Old list", active: false, members: 0, needsAttention: 0 },
];
const MEDIA_SYNC = { since: null, at: "2026-10-07T09:00:00.000Z", result: { contacts: 5, updated: 1, flagged: 1, removed: 0, errors: 0 }, running: false };
const MEDIA_MEMBERS: MediaMember[] = [
  { subscriberId: "44444444-4444-4444-4444-444444444444", email: "sam@riverbend.example.test", source: "media-hub", mediaHubContactId: 42, mediaHubEmailRef: "personal", needsAttention: "email-gone", attentionAt: "2026-10-06T09:00:00.000Z" },
  { subscriberId: "55555555-5555-5555-5555-555555555555", email: "lee@example.test", source: "manual-media", mediaHubContactId: null, mediaHubEmailRef: null, needsAttention: "bouncing", attentionAt: "2026-10-06T09:00:00.000Z" },
];
const MEDIA_OPTED = { items: [{ subscriberId: "33333333-3333-3333-3333-333333333333", email: "gone@example.test", at: "2026-09-01T17:00:00.000Z", member: false }], truncated: false };
const OPS: OperationsStatus = {
  nod: { paused: false, lastDigestCutoff: "2026-10-07T00:00:00.000Z" },
  distribution: { paused: false },
  bounceSource: "fake",
  bounceSummary: { address: "server@example.test", from: "server" },
  softCodesCounted: [],
  purge: {
    enabled: false,
    preview: { pendingSubscribers: 0, endedSubscribers: 3, unusedLinks: 2, expiredSendLinks: 40 },
    lastRun: null,
    nextRunAt: "2026-10-08T10:00:00.000Z",
  },
  emergencyFeed: {
    url: "https://emergency.example.test/feed.xml",
    checkedAt: "2026-10-07T18:00:00.000Z",
    result: { at: "2026-10-07T18:00:00.000Z", ok: true, seeded: false, inFeed: 2, created: 1, updated: 0, skipped: 0, failed: 0, error: null },
  },
};
const LISTS_VIEW: StaffListsView = {
  allNews: 12,
  categories: [
    {
      key: "ministries", name: "Ministries", enabled: true, namesFrom: "Core", editable: true,
      lists: [
        { listKey: "ministries:health", key: "health", name: "Health", active: true, enabled: true, subscribers: 40 },
        { listKey: "ministries:old", key: "old", name: "Old ministry", active: false, enabled: true, subscribers: 0 },
      ],
    },
    { key: "media-distribution-lists", name: "Media distribution lists", enabled: true, namesFrom: "NRMS", editable: false, lists: [{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, enabled: true, subscribers: 9 }] },
  ],
};
const MEDIA_CONTACT = {
  id: 42, firstName: "Sam", lastName: "Reporter", outlet: "Riverbend Gazette", deletedAt: null,
  emails: [
    { ref: "personal", address: "sam@riverbend.example.test", kind: "personal", organization: null, preferred: true },
    { ref: "workplace:1", address: "sam@gazette.example.test", kind: "workplace", organization: "Riverbend Gazette", preferred: false },
  ],
};

function stubCommon(roles: string[], overrides: Record<string, () => Response> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (overrides[url]) return overrides[url]();
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url === "/nod/api/subscribers/search") return jsonResponse(200, PAGE);
      if (url === "/nod/api/subscriber-list-options") return jsonResponse(200, OPTIONS);
      if (url === "/nod/api/subscribers/bulk") return jsonResponse(200, { changed: 0, skipped: [] });
      if (url === `/nod/api/subscribers/${SUBSCRIBER_ID}`) return jsonResponse(200, DETAIL);
      if (url === `/nod/api/subscribers/${SUBSCRIBER_ID}/history`) return jsonResponse(200, HISTORY);
      if (url === "/nod/api/media-lists") return jsonResponse(200, MEDIA_LISTS);
      if (url === "/nod/api/media-hub/sync") return jsonResponse(200, MEDIA_SYNC);
      if (url === "/nod/api/media-lists/budget/members") return jsonResponse(200, MEDIA_MEMBERS);
      if (url === "/nod/api/media-lists/budget/opted-out") return jsonResponse(200, MEDIA_OPTED);
      if (url === "/nod/api/media-hub/contacts/42") return jsonResponse(200, MEDIA_CONTACT);
      if (url === "/nod/api/operations") return jsonResponse(200, OPS);
      if (url === "/nod/api/list-categories") return jsonResponse(200, LISTS_VIEW);
      return jsonResponse(200, {});
    }),
  );
}

function withAuth(children: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>{children}</RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

function withAuthAt(path: string, pattern: string, element: React.ReactNode) {
  return (
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path={pattern} element={element} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe("accessibility — Subscribers", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("SubscribersScreen (Editor: checkboxes and bulk buttons present)", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuth(<SubscribersScreen />));
    await screen.findByRole("link", { name: "pat@example.test" });
    expect(screen.getByRole("checkbox", { name: "Select all on this page" })).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SubscribersScreen with the bulk delete dialog open", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuth(<SubscribersScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    await screen.findByRole("alertdialog");
    // React Aria hides the rest of the page from screen readers via `inert` on real browsers
    // (verified in @bcgov/design-system-react-components's ModalOverlay: it asks for
    // `shouldUseInert: true`), which also makes that content unfocusable. jsdom doesn't
    // implement `inert` at all, so the fallback here is aria-hidden alone, which axe correctly
    // flags as leaving focusable elements behind — a gap in this test environment, not in the
    // rendered page: this one rule is excluded from the check for that reason.
    expect(await seriousViolations(container, { rules: { "aria-hidden-focus": { enabled: false } } })).toEqual([]);
  });

  it("AddSubscriberScreen with options loaded", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={["/subscribers/new"]}>
          <RequireAuth>
            <Routes>
              <Route path="/subscribers/new" element={<AddSubscriberScreen />} />
            </Routes>
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByRole("checkbox", { name: "Health" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SubscriberScreen (Editor, populated)", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={[`/subscribers/${SUBSCRIBER_ID}`]}>
          <RequireAuth>
            <Routes>
              <Route path="/subscribers/:id" element={<SubscriberScreen />} />
            </Routes>
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByText("pat@example.test");
    await screen.findByRole("button", { name: "Save preferences" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SubscriberScreen with the delete dialog open", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={[`/subscribers/${SUBSCRIBER_ID}`]}>
          <RequireAuth>
            <Routes>
              <Route path="/subscribers/:id" element={<SubscriberScreen />} />
            </Routes>
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByRole("alertdialog");
    // See the matching note on the bulk delete dialog above: jsdom has no `inert`, so this one
    // rule is excluded from the check here too, for the same reason.
    expect(await seriousViolations(container, { rules: { "aria-hidden-focus": { enabled: false } } })).toEqual([]);
  });

  it("SubscriberScreen asking to confirm a change of email onto an opted-out address", async () => {
    stubCommon(["NoD.Editor"], { [`/nod/api/subscribers/${SUBSCRIBER_ID}/email`]: () => jsonResponse(409, { error: "opted-out", at: "2026-06-01T17:00:00.000Z" }) });
    render(
      <SessionProvider>
        <MemoryRouter initialEntries={[`/subscribers/${SUBSCRIBER_ID}`]}>
          <RequireAuth>
            <Routes>
              <Route path="/subscribers/:id" element={<SubscriberScreen />} />
            </Routes>
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("New email"), "left@example.test");
    await user.type(screen.getByLabelText("Confirm new email"), "left@example.test");
    await user.click(screen.getByRole("button", { name: "Change email" }));
    await screen.findByRole("alertdialog");
    // jsdom has no `inert` (see the bulk delete dialog's note above).
    expect(await seriousViolations(document.body, { rules: { "aria-hidden-focus": { enabled: false } } })).toEqual([]);
  });

  it("HistoryScreen (populated)", async () => {
    stubCommon(["NoD.Viewer"]);
    const { container } = render(
      <SessionProvider>
        <MemoryRouter initialEntries={[`/subscribers/${SUBSCRIBER_ID}/history`]}>
          <RequireAuth>
            <Routes>
              <Route path="/subscribers/:id/history" element={<HistoryScreen />} />
            </Routes>
          </RequireAuth>
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByRole("link", { name: "Back to subscriber" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("Lists and categories (Admin, with controls) has no serious violations", async () => {
    stubCommon(["NoD.Admin"]);
    const { container } = render(withAuthAt("/subscribers/lists", "/subscribers/lists", <ListsScreen />));
    await screen.findByRole("checkbox", { name: "Offer Health" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("Media lists has no serious violations", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuthAt("/subscribers/media-lists", "/subscribers/media-lists", <MediaListsScreen />));
    await screen.findByRole("link", { name: "Budget" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("A media list (Editor, populated) has no serious violations", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuthAt("/subscribers/media-lists/budget", "/subscribers/media-lists/:key", <MediaListScreen />));
    await screen.findByRole("button", { name: "Remove lee@example.test" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("A media list, with the remove dialog open, has no serious violations", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuthAt("/subscribers/media-lists/budget", "/subscribers/media-lists/:key", <MediaListScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Remove lee@example.test" }));
    await screen.findByRole("alertdialog");
    // See the note on the bulk delete dialog above: jsdom has no `inert`, so this one rule is
    // excluded here too. The dialog itself is checked, since it renders outside the container.
    const noInert = { rules: { "aria-hidden-focus": { enabled: false } } };
    expect(await seriousViolations(document.body, noInert)).toEqual([]);
    expect(await seriousViolations(container, noInert)).toEqual([]);
  });

  it("A media list, with the resolve dialog offering Media Hub emails, has no serious violations", async () => {
    stubCommon(["NoD.Editor"]);
    render(withAuthAt("/subscribers/media-lists/budget", "/subscribers/media-lists/:key", <MediaListScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Resolve sam@riverbend.example.test" }));
    await screen.findByRole("radio", { name: /sam@gazette\.example\.test/ });
    // jsdom has no `inert` (see the bulk delete dialog's note above).
    expect(await seriousViolations(document.body, { rules: { "aria-hidden-focus": { enabled: false } } })).toEqual([]);
  });

  it("A media list, with the resolve dialog refusing an opted-out email, has no serious violations", async () => {
    stubCommon(["NoD.Editor"], { "/nod/api/media-members/44444444-4444-4444-4444-444444444444/resolve": () => jsonResponse(409, { error: "opted-out-address" }) });
    render(withAuthAt("/subscribers/media-lists/budget", "/subscribers/media-lists/:key", <MediaListScreen />));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Resolve sam@riverbend.example.test" }));
    await user.click(await screen.findByRole("radio", { name: /sam@gazette\.example\.test/ }));
    await user.click(screen.getByRole("button", { name: "Use this email" }));
    await screen.findByText(/That address opted out of a media list this member is on/);
    // jsdom has no `inert` (see the bulk delete dialog's note above).
    expect(await seriousViolations(document.body, { rules: { "aria-hidden-focus": { enabled: false } } })).toEqual([]);
  });

  it("Operations, with the pause dialog open, has no serious violations", async () => {
    stubCommon(["NoD.Admin"]);
    const { container } = render(withAuthAt("/subscribers/operations", "/subscribers/operations", <OperationsScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Pause News On Demand sending" }));
    await screen.findByRole("alertdialog");
    // jsdom has no `inert` (see the bulk delete dialog's note above).
    const noInert = { rules: { "aria-hidden-focus": { enabled: false } } };
    expect(await seriousViolations(document.body, noInert)).toEqual([]);
    expect(await seriousViolations(container, noInert)).toEqual([]);
  });

  it("Operations, with the purge dialog open, has no serious violations", async () => {
    stubCommon(["NoD.Admin"]);
    const { container } = render(withAuthAt("/subscribers/operations", "/subscribers/operations", <OperationsScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Turn on the retention purge" }));
    await screen.findByRole("alertdialog");
    // jsdom has no `inert` (see the bulk delete dialog's note above).
    const noInert = { rules: { "aria-hidden-focus": { enabled: false } } };
    expect(await seriousViolations(document.body, noInert)).toEqual([]);
    expect(await seriousViolations(container, noInert)).toEqual([]);
  });
});
