/** Rows a table's legacy count must add up to (spec addendum §12.1, safety 4). */
export type Outcome = "outOfScope" | "planned" | "inserted" | "updated" | "unchanged" | "skipped";
const OUTCOMES: readonly Outcome[] = ["outOfScope", "planned", "inserted", "updated", "unchanged", "skipped"];
export const BALANCED_TABLES = ["users", "commContacts", "activities", "savedFilters", "favourites", "files", "logRows"] as const;
type Counts = Record<Outcome | "legacy", number>;

export interface CalendarImportReportJSON {
  mode: "dry-run" | "confirmed";
  cutoff: string;
  balanced: boolean;
  tables: Record<string, Counts>;
  skipped: { table: string; legacyId: string; reason: string }[];
  changedInCalendar: number[];
  /** Activities that break the shared validation, by field name only (imported anyway; fixed on next save). */
  validation: { activityId: number; fields: string[] }[];
  /** Per-activity mapping fallbacks (an unknown status or section, a dropped comm contact), by activity id only. */
  mapping: { activityId: number; notes: string[] }[];
  unknownKeys: { kind: string; guid: string }[];
  savedFilters: { strippedPrefix: number; dropped: { id: number; key: string; reason: string }[]; overCap: { ownerId: string; count: number }[] };
  /** Users whose existing Core access was left as it was, by legacy id and Core user id only. */
  usersAccessKept: { legacyIds: number[]; userId: string }[];
  /** Role-less placeholder users the import activated, by legacy id and Core user id only. */
  usersActivated: { legacyIds: number[]; userId: string }[];
  facts: Record<string, number>;
  notes: string[];
  failed: { stage: string; message: string } | null;
}

/** Holds counts, ids, field names and reasons only: never a title, an email or a saved query's typed values. */
export class CalendarImportReport {
  private readonly tables = new Map<string, Counts>();
  private readonly data: Omit<CalendarImportReportJSON, "mode" | "cutoff" | "balanced" | "tables"> = {
    skipped: [], changedInCalendar: [], validation: [], mapping: [], unknownKeys: [], savedFilters: { strippedPrefix: 0, dropped: [], overCap: [] },
    usersAccessKept: [], usersActivated: [], facts: {}, notes: [], failed: null,
  };
  constructor(readonly mode: "dry-run" | "confirmed", readonly cutoff: string) {}

  private row(table: string): Counts {
    let r = this.tables.get(table);
    if (!r) { r = { legacy: 0, outOfScope: 0, planned: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 }; this.tables.set(table, r); }
    return r;
  }
  legacy(table: string, n: number): void { this.row(table).legacy += n; }
  count(table: string, outcome: Outcome, n = 1): void { this.row(table)[outcome] += n; }
  skip(table: string, legacyId: string, reason: string): void { this.count(table, "skipped"); this.data.skipped.push({ table, legacyId, reason }); }
  listChangedInCalendar(id: number): void { this.data.changedInCalendar.push(id); }
  warn(activityId: number, fields: string[]): void { if (fields.length) this.data.validation.push({ activityId, fields }); }
  mapping(activityId: number, notes: string[]): void { if (notes.length) this.data.mapping.push({ activityId, notes }); }
  userAccessKept(legacyIds: number[], userId: string): void { this.data.usersAccessKept.push({ legacyIds, userId }); }
  userActivated(legacyIds: number[], userId: string): void { this.data.usersActivated.push({ legacyIds, userId }); }
  fact(name: string, value: number): void { this.data.facts[name] = value; }
  note(text: string): void { this.data.notes.push(text); }
  unknownKeys(list: { kind: string; guid: string }[]): void { this.data.unknownKeys.push(...list); }
  savedFilterNotes(n: CalendarImportReportJSON["savedFilters"]): void {
    this.data.savedFilters.strippedPrefix += n.strippedPrefix;
    this.data.savedFilters.dropped.push(...n.dropped);
    this.data.savedFilters.overCap.push(...n.overCap);
  }
  markFailed(stage: string, message: string): void { this.data.failed = { stage, message }; }
  balanced(): boolean {
    if (this.data.failed) return false;
    for (const r of this.tables.values()) if (r.legacy !== OUTCOMES.reduce((n, o) => n + r[o], 0)) return false;
    return true;
  }
  toJSON(): CalendarImportReportJSON {
    return {
      mode: this.mode, cutoff: this.cutoff, balanced: this.balanced(),
      tables: Object.fromEntries([...this.tables.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ...structuredClone(this.data),
    };
  }
  toText(): string {
    const j = this.toJSON();
    const lines = [`Calendar import (${j.mode}, cutoff ${j.cutoff}): ${j.balanced ? "balanced" : "NOT BALANCED"}${j.failed ? `; failed during ${j.failed.stage}: ${j.failed.message}` : ""}`];
    for (const [t, c] of Object.entries(j.tables)) lines.push(`  ${t}: legacy=${c.legacy} outOfScope=${c.outOfScope} planned=${c.planned} inserted=${c.inserted} updated=${c.updated} unchanged=${c.unchanged} skipped=${c.skipped}`);
    if (j.unknownKeys.length) { lines.push("Unknown legacy keys (fix Core first):"); for (const k of j.unknownKeys) lines.push(`  ${k.kind} ${k.guid}`); }
    if (j.changedInCalendar.length) lines.push(`Changed in the Calendar since the last import (not overwritten): ${j.changedInCalendar.join(", ")}`);
    if (j.skipped.length) { lines.push("Skipped:"); for (const s of j.skipped) lines.push(`  [${s.table}] ${s.legacyId}: ${s.reason}`); }
    if (j.validation.length) { lines.push("Validation problems (imported; fixed on next save):"); for (const v of j.validation) lines.push(`  ${v.activityId}: ${v.fields.join(", ")}`); }
    if (j.mapping.length) { lines.push("Mapping fallbacks:"); for (const m of j.mapping) for (const n of m.notes) lines.push(`  ${m.activityId}: ${n}`); }
    if (j.usersAccessKept.length) { lines.push("Users whose existing Core access was kept:"); for (const u of j.usersAccessKept) lines.push(`  ${u.legacyIds.join(",")} -> ${u.userId}`); }
    if (j.usersActivated.length) { lines.push("Users the import activated:"); for (const u of j.usersActivated) lines.push(`  ${u.legacyIds.join(",")} -> ${u.userId}`); }
    if (Object.keys(j.facts).length) { lines.push("Facts:"); for (const [k, v] of Object.entries(j.facts)) lines.push(`  ${k}: ${v}`); }
    for (const n of j.notes) lines.push(`Note: ${n}`);
    return lines.join("\n");
  }
}
