import type { CalendarRangeView, ListFilter, ListOptions, ListPage, ListPreferences, ListQuery, SavedFilterView } from "@gcpe/calendar-contract";
import { apiFetch } from "../../../api/client";
import type { CalendarConfigView, ClearLaStatusResult, ReviewSelectedResult } from "./types";

const q = (query: ListQuery) => encodeURIComponent(JSON.stringify(query));

/** Every call the activity list makes (spec addendum §8.1), through apiFetch. */
export const listApi = {
  page: (query: ListQuery, offset: number) => apiFetch<ListPage>(`/calendar/api/list?q=${q(query)}&offset=${offset}`),
  options: () => apiFetch<ListOptions>("/calendar/api/list/options"),
  config: () => apiFetch<CalendarConfigView>("/calendar/api/config"),
  preferences: () => apiFetch<ListPreferences>("/calendar/api/list/preferences"),
  savePreferences: (p: ListPreferences) => apiFetch<ListPreferences>("/calendar/api/list/preferences", { method: "PUT", body: p }),
  watch: (id: number, on: boolean) => apiFetch<void>(`/calendar/api/activities/${id}/watch`, { method: on ? "PUT" : "DELETE" }),
  savedFilters: () => apiFetch<SavedFilterView[]>("/calendar/api/saved-filters"),
  saveFilter: (name: string, filter: ListFilter) => apiFetch<SavedFilterView>("/calendar/api/saved-filters", { method: "POST", body: { name, filter } }),
  renameFilter: (id: number, name: string) => apiFetch<SavedFilterView>(`/calendar/api/saved-filters/${id}`, { method: "PUT", body: { name } }),
  reorderFilters: (ids: number[]) => apiFetch<SavedFilterView[]>("/calendar/api/saved-filters/order", { method: "PUT", body: { ids } }),
  deleteFilter: (id: number) => apiFetch<void>(`/calendar/api/saved-filters/${id}`, { method: "DELETE" }),
  reviewSelected: (items: { id: number; version: number }[]) => apiFetch<ReviewSelectedResult>("/calendar/api/activities/review-selected", { method: "POST", body: { items } }),
  clearLaStatus: (days: number) => apiFetch<ClearLaStatusResult>("/calendar/api/activities/clear-la-status", { method: "POST", body: { days } }),
  calendar: (query: ListQuery, start: string, end: string) => apiFetch<CalendarRangeView>(`/calendar/api/list/calendar?q=${q(query)}&start=${start}&end=${end}`),
  exportUrl: (query: ListQuery) => `/calendar/api/list/export.xlsx?q=${q(query)}`,
};

/** The Excel export as a download. A refusal comes back as an Error carrying the server's own message. */
export async function downloadExport(query: ListQuery): Promise<void> {
  const res = await fetch(listApi.exportUrl(query), { credentials: "same-origin" });
  if (!res.ok) {
    let message = "Couldn't export the list.";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON: keep the general message.
    }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "BCGovernmentActivities.xlsx";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
