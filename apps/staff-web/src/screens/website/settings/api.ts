import type { FieldError, SectionKey, SiteSettings } from "@gcpe/site-settings";
import { apiFetch } from "../../../api/client";

/**
 * The NRMS site-settings API as the Hub sees it (apps/nrms/src/http/site-routes.ts and
 * apps/nrms/src/website/site-settings.ts own the shapes; staff-web can't import NRMS, so they
 * are restated here).
 */

export interface LiveInfo {
  revision: number;
  publishedAt: string;
  publishedBy: string;
  note: string | null;
}

export interface SettingsState {
  live: LiveInfo | null;
  /** The editor's draft, else live, else the tenant defaults. */
  document: SiteSettings;
  draft: { baseRevision: number | null; updatedAt: string } | null;
  /** The publish concurrency token: send it back with every draft save and publish. */
  baseRevision: number | null;
  /** Every problem in `document`, any section. */
  errors: FieldError[];
  /** Sections where the draft differs from what is live (empty with no draft): what Discard draft throws away. */
  draftSections: SectionKey[];
}

/** 409 body: someone published since `baseRevision`. */
export interface PublishConflict {
  live: LiveInfo | null;
  differing: SectionKey[];
}

/** 422 body. */
export interface PublishInvalid {
  errors: string[];
  fieldErrors: FieldError[];
}

const BASE = "/nrms/api/site/settings";

export const getSettings = () => apiFetch<SettingsState>(BASE);

export const saveSettingsDraft = (body: { baseRevision: number | null; section: SectionKey; value: unknown }) =>
  apiFetch<SettingsState>(`${BASE}/draft`, { method: "PUT", body });

/** Throws an ApiError: 422 with a {@link PublishInvalid} body, 409 with a {@link PublishConflict} one. */
export const publishSettings = (body: { baseRevision: number | null; section: SectionKey; value: unknown; note?: string }) =>
  apiFetch<{ revision: number; state: SettingsState }>(`${BASE}/publish`, { method: "POST", body });

export const discardSettingsDraft = () => apiFetch<void>(`${BASE}/draft`, { method: "DELETE" });

export const rebaseSettings = (body: { section: SectionKey; value: unknown }) =>
  apiFetch<SettingsState & { setAside: SectionKey[] }>(`${BASE}/rebase`, { method: "POST", body });

/** The tenant's own defaults (what "Reset to defaults" puts back). */
export const getSettingsDefaults = () => apiFetch<SiteSettings>(`${BASE}/defaults`);

export interface HistoryList {
  /** The live revision number, or null before anything is published. */
  live: number | null;
  /** Newest first. */
  revisions: LiveInfo[];
}

export const getHistory = () => apiFetch<HistoryList>(`${BASE}/history`);

export interface RevisionDetail {
  info: LiveInfo;
  document: SiteSettings;
  /** Sections where this revision differs from what is live now. */
  differing: SectionKey[];
}

export const getRevision = (revision: number) => apiFetch<RevisionDetail>(`${BASE}/history/${revision}`);

/** Throws an ApiError: 409 with a {@link PublishConflict} body, 404 when the revision is gone, 422 when it no longer validates. */
export const restoreRevision = (body: { revision: number; baseRevision: number | null }) =>
  apiFetch<{ revision: number }>(`${BASE}/restore`, { method: "POST", body });
