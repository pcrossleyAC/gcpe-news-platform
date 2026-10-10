import type { EditorRules } from "@gcpe/calendar-contract";

/** GET /calendar/api/config, the parts the list reads. */
export interface CalendarConfigView {
  timeZone: string;
  freeze: { start: string; end: string; timeZone: string; active: boolean; appliesToYou: boolean; message: string };
  list: { markup: boolean; corporateQueries: boolean; lookAheadFilter: boolean; reviewSelected: boolean; clearLaStatus: boolean };
  /** The caller sees the Look Ahead fieldset on a new activity; an existing one says so through its view's `lookAhead`. */
  lookAheadFieldset: boolean;
  /** Records shows on every activity, not only those that already have files (spec addendum §8.2; Q51). */
  showRecordsSection: boolean;
  /** The rules the editor runs in the browser (spec addendum §7.2, §7.6). */
  rules: EditorRules;
  editor: { create: boolean; relaxRequired: boolean; useHqPlaceholder: boolean };
}

/** apps/calendar/src/activities/bulk.ts. A 207 carries `failed: true`: a later batch rolled back after earlier ones committed. */
export interface ReviewSelectedResult {
  reviewed: number[];
  skipped: { id: number; reason: "changed" | "not_found" }[];
  failed?: true;
}
export interface ClearLaStatusResult {
  cleared: number;
  failed?: true;
}

export type ListView = "list" | "month" | "week";
