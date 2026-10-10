import { REPORT_FILE_NAMES, type CalendarRangeView, type ListFilter, type ListOptions, type ListPage, type ListPreferences, type ListQuery, type ReportJobView, type ReportKind, type SavedFilterView } from "@gcpe/calendar-contract";
import { ApiError, apiFetch, reportUnauthorized } from "../../../api/client";
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
  startReport: (report: ReportKind, query: ListQuery) => apiFetch<ReportJobView>(`/calendar/api/reports/${report}`, { method: "POST", body: { q: query } }),
  reportJob: (id: string) => apiFetch<ReportJobView>(`/calendar/api/reports/jobs/${encodeURIComponent(id)}`),
  reportPdfUrl: (id: string) => `/calendar/api/reports/jobs/${encodeURIComponent(id)}/pdf`,
};

/** A file from the API, saved by the browser. A refusal comes back as an Error carrying the server's own message. */
export async function downloadFile(url: string, fileName: string, fallback: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    // A session that ended sends the user to sign in and back, as apiFetch does.
    if (res.status === 401) reportUnauthorized();
    let message = fallback;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON: keep the general message.
    }
    throw new Error(message);
  }
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/** The Excel export as a download. */
export function downloadExport(query: ListQuery): Promise<void> {
  return downloadFile(listApi.exportUrl(query), "BCGovernmentActivities.xlsx", "Couldn't export the list.");
}

/** How often a report being prepared is asked about, and for how long before giving up. */
export const REPORT_POLL_MS = 1000;
export const REPORT_WAIT_MAX_MS = 5 * 60_000;

/** A cooperative cancellation flag: set once the caller no longer wants the poll to continue
 * (the component that started it unmounted, or the user navigated away). Not the DOM
 * AbortSignal — there's no in-flight request to abort, only a loop to stop scheduling. */
export interface ReportCancellation {
  aborted: boolean;
}

/**
 * A report (spec addendum §10): started from the current query, polled while the server prepares
 * it, then saved as a PDF. Stops polling with no further effect once `signal.aborted` is set.
 */
export async function runReport(
  report: ReportKind,
  query: ListQuery,
  o: { sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: ReportCancellation } = {},
): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? Date.now;
  const aborted = () => o.signal?.aborted ?? false;
  let job = await listApi.startReport(report, query);
  const giveUp = now() + REPORT_WAIT_MAX_MS;
  while (job.status === "running") {
    if (aborted()) return;
    if (now() > giveUp) throw new Error("The report is taking too long. Try again later, or narrow the filter.");
    await sleep(REPORT_POLL_MS);
    if (aborted()) return;
    try {
      job = await listApi.reportJob(job.id);
    } catch (e) {
      // A server restart (SiteGround stops an idle process) forgets every report being prepared.
      if (e instanceof ApiError && e.status === 404) throw new Error("The report was lost while it was being prepared. Run it again.");
      throw e;
    }
  }
  if (job.status === "failed") throw new Error(job.error ?? "The report couldn't be prepared. Try again.");
  await downloadFile(listApi.reportPdfUrl(job.id), REPORT_FILE_NAMES[report], "Couldn't download the report.");
}
