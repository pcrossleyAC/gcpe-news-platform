import { render } from "@testing-library/react";
import { vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import type { CalendarRangeView, ListOptions, ListPage, ListPreferences, ListRow, SavedFilterView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { RequireAuth } from "../../../session/RequireAuth";
import { SessionProvider } from "../../../session/SessionContext";
import { CalendarSection } from "../CalendarSection";
import { ActivityListScreen } from "./ActivityListScreen";
import type { CalendarConfigView } from "./types";

export const ME = { userId: "u1", displayName: "Robin Staff", role: "Calendar.Editor", level: 2, ministryKeys: ["health"], isHq: false };
export const HQ_ADMIN_ME = { userId: "u9", displayName: "Sample HQ Admin", role: "Calendar.Administrator", level: 4, ministryKeys: ["gcpe-hq"], isHq: true };
export const CONFIG: CalendarConfigView = {
  timeZone: "America/Vancouver",
  freeze: { start: "16:00", end: "17:00", timeZone: "America/Vancouver", active: false, appliesToYou: false, message: "You cannot make content changes between 4pm-5pm. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time." },
  list: { markup: false, corporateQueries: false, lookAheadFilter: false, reviewSelected: false, clearLaStatus: false },
  lookAheadFieldset: false,
  showRecordsSection: false,
  rules: {
    timeZone: "America/Vancouver",
    releaseCategoryIds: [12, 58],
    required: { significance: true, scheduling: true, strategy: false },
    awarenessCategoryIds: [2],
    consultationsMinistryAbbreviation: "CONSULT",
    issueExemptCategoryNames: ["Sample approved event"],
    eventsCategoryNames: ["Sample approved event"],
    unconfirmedIssueCommMaterialId: 61,
    hqPlaceholderCategoryName: "Sample HQ placeholder",
    contactMinistryExcludedAbbreviations: ["EXCL"],
    sharedWithExcludedAbbreviations: ["EXCL"],
    releaseHiddenCategoryNames: ["Sample awareness"],
    otherCityId: 311,
    translationsDefault: ["Sample language A", "Sample language B"],
  },
  editor: { create: true, relaxRequired: false, useHqPlaceholder: false },
};
export const HQ_ADMIN_CONFIG: CalendarConfigView = {
  ...CONFIG,
  list: { markup: true, corporateQueries: true, lookAheadFilter: true, reviewSelected: true, clearLaStatus: true },
  lookAheadFieldset: true,
  editor: { create: true, relaxRequired: true, useHqPlaceholder: true },
};
export const OPTIONS: ListOptions = {
  categories: [{ id: 32, name: "Sample category" }],
  keywords: [{ id: 1, name: "Sample tag" }, { id: 2, name: "Sample other tag" }],
  representatives: [{ id: 1, name: "Sample Representative" }],
  initiatives: [{ id: 1, name: "Sample initiative" }],
  premierRequested: [{ id: 1, name: "Sample yes" }],
  distributions: [{ id: 1, name: "Sample distribution" }],
  ministries: [{ key: "health", abbreviation: "HLTH", name: "Sample Health" }],
  commContacts: [{ userId: "u1", name: "Robin Staff" }],
};
export const PREFS: ListPreferences = { display: "all", hiddenColumns: ["keywords", "ministry", "status", "translations"] };

export function row(over: Partial<ListRow> = {}): ListRow {
  return {
    id: 20001, version: 1, ministryKey: "health", ministryAbbreviation: "HLTH", status: "new", hqStatus: null, isDeleted: false,
    isWatched: false, watcherNames: [], isShared: false, hasRelease: false,
    createdAt: "2026-11-01T17:00:00.000Z", lastUpdatedAt: "2026-11-02T17:00:00.000Z", lastUpdatedByName: "Robin Staff",
    keywords: [], startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, potentialDates: "",
    title: "Sample listed", details: "Sample summary", significance: "Sample significance", strategy: "", schedule: "",
    categories: ["Sample category"], isIssue: false, isConfidential: false, commMaterials: [], nrOrigins: [], nrDistribution: null,
    premierRequested: null, leadOrganization: "", translations: [], city: "Sample City", venue: "",
    commContact: { name: "Robin Staff", phone: "250-555-0101" }, governmentRepresentative: null, eventPlanner: null, needsReview: [],
    ...over,
  };
}

export interface Call {
  url: string;
  init?: RequestInit;
}
export interface Stub {
  me?: object;
  config?: CalendarConfigView;
  preferences?: ListPreferences;
  page?: (offset: number, q: Record<string, unknown>) => ListPage | Promise<ListPage>;
  saved?: SavedFilterView[];
  calendar?: CalendarRangeView;
  /** Answers first; return undefined to fall through to the defaults, or a promise to hold the answer. */
  other?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
}

export const qOf = (url: string) => JSON.parse(new URL(url, "http://staff.example.test").searchParams.get("q")!) as Record<string, unknown>;
/** A response that never arrives, for a state that lasts while one is awaited. */
export const never = () => new Promise<never>(() => {});
export const listCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("/calendar/api/list?"));

export function stubFetch(calls: Call[], s: Stub = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const custom = s.other?.(url, init);
      if (custom) return custom;
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Robin Staff", email: "robin.staff@example.test", roles: ["Calendar.Editor"] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      if (url === "/calendar/api/me") return jsonResponse(200, s.me ?? ME);
      if (url === "/calendar/api/config") return jsonResponse(200, s.config ?? CONFIG);
      if (url === "/calendar/api/list/options") return jsonResponse(200, OPTIONS);
      if (url === "/calendar/api/list/preferences") return jsonResponse(200, init?.method === "PUT" ? JSON.parse(String(init.body)) : (s.preferences ?? PREFS));
      if (url.startsWith("/calendar/api/list/calendar?")) return jsonResponse(200, s.calendar ?? { items: [], truncated: false });
      if (url.startsWith("/calendar/api/list?")) {
        const offset = Number(new URL(url, "http://staff.example.test").searchParams.get("offset") ?? 0);
        return jsonResponse(200, await (s.page ?? (() => ({ rows: [row()], total: 1, offset: 0 })))(offset, qOf(url)));
      }
      if (url === "/calendar/api/saved-filters") return jsonResponse(200, s.saved ?? []);
      throw new Error(`unhandled: ${init?.method ?? "GET"} ${url}`);
    }),
  );
}

export const renderList = (path = "/calendar") =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar" element={<CalendarSection />}>
              <Route index element={<ActivityListScreen />} />
            </Route>
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
