import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { FeedItem, FeedPage } from "@gcpe/calendar-contract";
import { RequireAuth } from "../../../session/RequireAuth";
import { SessionProvider } from "../../../session/SessionContext";
import { CalendarSection } from "../CalendarSection";
import type { Call } from "../list/fixtures";
import { UpdatesScreen } from "./UpdatesScreen";

export function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 1, at: "2026-11-03T18:00:00.000Z", action: "updated", actorName: "Robin Staff", activityId: 20001, ministryAbbreviation: "HLTH",
    title: "Sample title", details: "Sample summary", startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z",
    isAllDay: false, isConfirmed: true, potentialDates: null, isDeleted: false, ...over,
  };
}

export function feedPage(over: Partial<FeedPage> = {}): FeedPage {
  return { mode: "today", activityId: null, items: [item()], truncated: false, ...over };
}

/** The feed requests made, as their query strings. */
export const feedCalls = (calls: Call[]) =>
  calls.filter((c) => c.url.startsWith("/calendar/api/updates?")).map((c) => new URL(c.url, "http://staff.example.test").searchParams.toString());

/** Answers the feed's requests; anything else falls through to stubFetch's defaults. */
export const answerFeed = (fn: (params: URLSearchParams) => Response | Promise<Response>) => (url: string) =>
  url.startsWith("/calendar/api/updates?") ? fn(new URL(url, "http://staff.example.test").searchParams) : undefined;

export const renderUpdates = (path = "/calendar/updates") =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar" element={<CalendarSection />}>
              <Route path="updates" element={<UpdatesScreen />} />
            </Route>
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
