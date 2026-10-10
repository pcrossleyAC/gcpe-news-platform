/** GET /calendar/api/config, the parts the list reads. */
export interface CalendarConfigView {
  timeZone: string;
  freeze: { start: string; end: string; timeZone: string; active: boolean; appliesToYou: boolean; message: string };
  list: { markup: boolean; corporateQueries: boolean; lookAheadFilter: boolean; reviewSelected: boolean; clearLaStatus: boolean };
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
