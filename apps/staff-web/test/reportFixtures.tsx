import { vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "./jsonResponse";
import { SessionProvider } from "../src/session/SessionContext";
import { RequireAuth } from "../src/session/RequireAuth";
import type { MembersPage, SubscribersByListReport, UnsubscribesPage } from "../src/screens/subscribers/reports/types";

export const BY_LIST: SubscribersByListReport = {
  all: { subscribers: 120, asItHappens: 100, digest: 40 },
  allNews: { subscribers: 30, asItHappens: 25, digest: 10 },
  categories: [
    {
      key: "ministries",
      name: "Ministries",
      lists: [
        { listKey: "ministries:health", name: "Health", active: true, subscribers: 40, asItHappens: 35, digest: 12 },
        { listKey: "ministries:old", name: "Old ministry", active: false, subscribers: 2, asItHappens: 2, digest: 0 },
      ],
    },
    { key: "themes", name: "Themes", lists: [] },
  ],
};

export const MEMBERS: MembersPage = {
  list: "ministries:health",
  listName: "Health",
  timing: "any",
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    { id: "11111111-1111-1111-1111-111111111111", email: "pat@example.test", asItHappens: true, digest: false, source: "self", createdAt: "2026-09-01T17:00:00.000Z" },
    { id: "22222222-2222-2222-2222-222222222222", email: "lee@example.test", asItHappens: false, digest: true, source: "admin", createdAt: "2026-11-15T20:05:00.000Z" },
  ],
};

export const UNSUBSCRIBES: UnsubscribesPage = {
  since: "2026-07-09",
  summary: { subscribed: 12, resubscribed: 3, unsubscribed: 5, staffDeleted: 1 },
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    { subscriberId: "33333333-3333-3333-3333-333333333333", email: "gone@example.test", how: "subscriber", at: "2026-10-05T16:30:00.000Z", status: "deleted", registeredAt: "2026-01-02T17:00:00.000Z" },
    { subscriberId: "44444444-4444-4444-4444-444444444444", email: "back@example.test", how: "staff", at: "2026-10-01T16:30:00.000Z", status: "active", registeredAt: "2025-05-02T17:00:00.000Z" },
  ],
};

type Responder = () => Response;
/** Default answers by URL prefix, most specific first. */
const DEFAULTS: [string, Responder][] = [
  ["/nod/api/reports/subscribers-by-list/members", () => jsonResponse(200, MEMBERS)],
  ["/nod/api/reports/subscribers-by-list", () => jsonResponse(200, BY_LIST)],
  ["/nod/api/reports/unsubscribes", () => jsonResponse(200, UNSUBSCRIBES)],
];

/** Stubs fetch: the session (with `roles`), the tenant config, and every report route. An
 * `overrides` entry wins for any URL starting with its key. */
export function stubReports(roles: string[], overrides: Record<string, Responder> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    for (const [prefix, respond] of Object.entries(overrides)) if (url.startsWith(prefix)) return respond();
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    for (const [prefix, respond] of DEFAULTS) if (url.startsWith(prefix)) return respond();
    throw new Error(`unhandled: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export const calledUrls = (fetchMock: ReturnType<typeof stubReports>): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

export function renderAt(path: string, pattern: string, element: React.ReactNode) {
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path={pattern} element={element} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}
