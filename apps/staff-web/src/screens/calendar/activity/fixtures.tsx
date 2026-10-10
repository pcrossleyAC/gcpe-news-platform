import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { ActivityFields, ActivityView, EditorOptions } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { RequireAuth } from "../../../session/RequireAuth";
import { SessionProvider } from "../../../session/SessionContext";
import { CalendarSection } from "../CalendarSection";
import { CONFIG, ME } from "../list/fixtures";
import type { CalendarConfigView } from "../list/types";
import { ActivityRoute } from "./ActivityScreen";

export const FIELDS: ActivityFields = {
  categoryId: 32, title: "Sample activity", details: "Sample summary", significance: "Sample significance", strategy: "", schedule: "Sample scheduling",
  comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
  isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
  startDate: "2031-11-10", startTime: "09:00", endDate: "2031-11-10", endTime: "10:00", nrDate: null, nrTime: null,
  contactMinistryKey: "health", commContactId: 11, governmentRepresentativeId: null, cityId: 1, premierRequestedId: null, nrDistributionId: null,
  eventPlannerId: null, videographerId: null, nrOriginId: null,
  commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
};

export function view(over: Partial<ActivityView> = {}): ActivityView {
  return {
    id: 20001, ministryAbbreviation: "HLTH", version: 3, status: "new", isDeleted: false, fields: FIELDS,
    startAt: "2031-11-10T17:00:00.000Z", endAt: "2031-11-10T18:00:00.000Z", nrAt: null, lookAhead: null, needsReview: [],
    createdAt: "2026-11-01T17:00:00.000Z", lastUpdatedAt: "2026-11-02T17:00:00.000Z", lastUpdatedByName: "Robin Staff", lock: null,
    can: { edit: true, clone: true, delete: false, review: false }, watch: { isWatched: false, watcherNames: [] }, files: [], releases: [],
    ...over,
  };
}

const opt = (id: number, name: string, isActive = true) => ({ id, name, isActive });
export const EDITOR_OPTIONS: EditorOptions = {
  categories: [opt(32, "Sample category"), opt(2, "Sample awareness"), opt(12, "Sample proposed release"), opt(33, "Sample HQ placeholder", false), opt(34, "Sample retired category", false)],
  cities: [opt(1, "Sample City"), opt(311, "Other...")],
  commMaterials: [opt(1, "Sample news release")],
  eventPlanners: [opt(1, "Sample Planner")],
  representatives: [opt(1, "Sample Representative")],
  initiatives: [{ ...opt(1, "Sample initiative"), shortName: "SI" }],
  keywords: [opt(1, "Sample tag")],
  distributions: [opt(1, "Sample distribution")],
  origins: [opt(1, "Sample origin")],
  premierRequested: [opt(1, "Sample yes")],
  videographers: [opt(1, "Sample Videographer")],
  ministries: [
    { key: "health", abbreviation: "HLTH", name: "Sample Health", isActive: true },
    { key: "finance", abbreviation: "FIN", name: "Sample Finance", isActive: true },
    { key: "gcpe-hq", abbreviation: "HQ", name: "Sample HQ", isActive: true },
  ],
  commContacts: [{ id: 11, ministryKey: "health", name: "Robin Staff", rank: 4, isActive: true }, { id: 12, ministryKey: "finance", name: "Kim Finance", rank: 1, isActive: true }],
  sectors: [{ key: "sample-sector", name: "Sample sector", isActive: true }],
  themes: [{ key: "sample-theme", name: "Sample theme", isActive: true }],
  tags: [{ key: "sample-tag", name: "Sample news tag", isActive: true }],
};

export interface Call {
  url: string;
  init?: RequestInit;
}
export interface ActivityStub {
  me?: object;
  config?: CalendarConfigView;
  roles?: string[];
  /** The activity GET answers this; a function sees the id, and may answer a Response (a 404). */
  view?: ActivityView | ((id: number) => ActivityView | Response);
  /** Answers first; return undefined to fall through. May throw, as a network failure does. */
  other?: (url: string, init?: RequestInit) => Response | undefined;
}

export function stubActivity(calls: Call[], s: ActivityStub = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const custom = s.other?.(url, init);
      if (custom) return custom;
      const method = init?.method ?? "GET";
      if (url === "/core/auth/session") {
        return jsonResponse(200, { user: { id: "u1", name: "Robin Staff", email: "robin.staff@example.test", roles: s.roles ?? ["Calendar.Editor"] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (url === "/calendar/api/me") return jsonResponse(200, s.me ?? ME);
      if (url === "/calendar/api/config") return jsonResponse(200, s.config ?? CONFIG);
      if (url === "/calendar/api/editor-options") return jsonResponse(200, EDITOR_OPTIONS);
      const m = /^\/calendar\/api\/activities\/(\d+)$/.exec(url);
      if (m && method === "GET") {
        const v = typeof s.view === "function" ? s.view(Number(m[1])) : (s.view ?? view());
        return v instanceof Response ? v : jsonResponse(200, v);
      }
      if (/\/lock$/.test(url) && method === "PUT") return jsonResponse(200, { holderName: "Robin Staff", since: "2026-11-03T18:00:00.000Z", mine: true, tabId: "t" });
      if (/\/lock\/release$/.test(url)) return new Response(null, { status: 204 });
      throw new Error(`unhandled: ${method} ${url}`);
    }),
  );
}

/** Stands in for the list: shows the notice the editor leaves. */
export function ListStub(): React.JSX.Element {
  const state = useLocation().state as { calendarNotice?: string } | null;
  return (
    <>
      <h1>Sample list</h1>
      {state?.calendarNotice && <p role="status">{state.calendarNotice}</p>}
    </>
  );
}

/** A data router (the editor's leave-page guard needs one), with the Calendar section around the editor. */
export function renderActivity(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/calendar",
        element: (
          <RequireAuth>
            <CalendarSection />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <ListStub /> },
          { path: "activities/new", element: <ActivityRoute /> },
          { path: "activities/:id", element: <ActivityRoute /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const rendered = render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { router, ...rendered };
}
