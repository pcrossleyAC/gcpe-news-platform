import type { ActivityChangeView, ActivityFields, ActivityFileView, ActivityView, EditorOptions, UpdateActivityInput, WriteResponse } from "@gcpe/calendar-contract";
import { apiFetch } from "../../../api/client";

const a = (id: number) => `/calendar/api/activities/${id}`;

/** Every call the activity editor makes (spec addendum §7, §8.2–§8.4), through apiFetch. */
export const activityApi = {
  get: (id: number) => apiFetch<ActivityView>(a(id)),
  changes: (id: number) => apiFetch<ActivityChangeView[]>(`${a(id)}/changes`),
  options: () => apiFetch<EditorOptions>("/calendar/api/editor-options"),
  create: (fields: ActivityFields) => apiFetch<WriteResponse>("/calendar/api/activities", { method: "POST", body: fields }),
  update: (id: number, body: UpdateActivityInput) => apiFetch<WriteResponse>(a(id), { method: "PUT", body }),
  clone: (id: number) => apiFetch<WriteResponse>(`${a(id)}/clone`, { method: "POST", body: {} }),
  remove: (id: number, version: number) => apiFetch<void>(a(id), { method: "DELETE", body: { version } }),
  review: (id: number, version: number) => apiFetch<ActivityView>(`${a(id)}/review`, { method: "POST", body: { version } }),
  lock: (id: number, tabId: string, takeOver = false) =>
    apiFetch<{ holderName: string; since: string; mine: true; tabId: string }>(`${a(id)}/lock`, { method: "PUT", body: takeOver ? { tabId, takeOver } : { tabId } }),
  /** keepalive lets the request finish as the page goes, and apiFetch adds the X-GCPE-Request header the server requires (C169), which navigator.sendBeacon can't. */
  release: (id: number, tabId: string) => apiFetch<void>(`${a(id)}/lock/release`, { method: "POST", body: { tabId }, keepalive: true }),
  // Never ?name=: a query string lands in every proxy's access logs, including a confidential
  // activity's file name (the server refuses it with 400 — apps/calendar/src/http/file-routes.ts).
  // apiFetch already passes `headers` through to `fetch` (RequestInit), so no client change is needed.
  addFile: (id: number, file: File) => apiFetch<ActivityFileView[]>(`${a(id)}/files`, { method: "POST", raw: file, headers: { "X-GCPE-File-Name": encodeURIComponent(file.name) } }),
  removeFile: (id: number, fileId: number) => apiFetch<ActivityFileView[]>(`${a(id)}/files/${fileId}`, { method: "DELETE" }),
  fileUrl: (id: number, fileId: number) => `${a(id)}/files/${fileId}`,
};
