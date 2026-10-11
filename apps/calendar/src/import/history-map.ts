import { wallClockToInstant } from "@gcpe/legacy-import";
import type { HistoryFieldKey } from "@gcpe/calendar-contract";
import type { LegacyLog } from "./legacy-rows";
import { stripNul } from "./map";

/** The only members legacy logged as "Update" (Calendar/ActivityManager.cs:291-305), PriorityId aside. An explicit table:
 * a FieldName not here is skipped, never passed through, so no HQ-only key can arrive under an unexpected name. */
export const LEGACY_LOG_FIELDS: Readonly<Record<string, HistoryFieldKey>> = {
  Title: "title", StartDateTime: "start", EndDateTime: "end", CityId: "city", IsConfirmed: "is_confirmed",
  CommunicationContactId: "comm_contact", ContactMinistryId: "contact_ministry", ActivityCategoriesId: "category",
  ActivityCommunicationMaterialsId: "comm_materials", NewsReleaseOriginId: "nr_origins", NewsReleaseDistributionId: "nr_distribution",
  ActivityThemesId: "themes",
};

export interface HistoryContext {
  timeZone: string;
  userIdOf(legacyId: number | null): string | null;
  actorNameOf(legacyId: number | null): string | null;
  cityNameOf(id: number): string | null;
  commContactLabelOf(id: number): string | null;
  orgNameOf(guid: string): string | null;
  contactMinistryKeyOf(activityId: number): string | null;
}
export interface HistoryEntry {
  legacyKey: string;
  activityId: number;
  logIds: number[];
  at: Date;
  actorId: string | null;
  actorName: string;
  contactMinistryKey: string | null;
  fields: { key: HistoryFieldKey; old: string | null; new: string | null }[];
}

const asInt = (v: string) => (/^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : null);

function display(key: HistoryFieldKey, raw: string | null, ctx: HistoryContext): string | null {
  if (raw === null) return null;
  const v = stripNul(raw);
  if (v.trim() === "") return null;
  const id = asInt(v);
  switch (key) {
    case "city": return (id !== null && ctx.cityNameOf(id)) || v;
    case "comm_contact": return (id !== null && ctx.commContactLabelOf(id)) || v;
    case "contact_ministry": return ctx.orgNameOf(v) ?? v;
    case "is_confirmed": return /^true$/i.test(v) ? "Yes" : /^false$/i.test(v) ? "No" : v;
    default: return v;
  }
}

/** Legacy log rows of imported activities as history entries (spec addendum §12.1 step 7). */
export function mapHistory(logs: LegacyLog[], ctx: HistoryContext): { entries: HistoryEntry[]; skipped: { logId: number; reason: string }[] } {
  const skipped: { logId: number; reason: string }[] = [];
  const groups = new Map<string, { rows: LegacyLog[]; wall: Date }>();
  for (const l of [...logs].sort((a, b) => a.Id - b.Id)) {
    if (l.Operation === "Edit") { skipped.push({ logId: l.Id, reason: "Edit row (lock noise)" }); continue; }
    if (l.Operation !== "Update") { skipped.push({ logId: l.Id, reason: "not an Update row" }); continue; }
    if (l.FieldName === "PriorityId") { skipped.push({ logId: l.Id, reason: "PriorityId (dropped, R9)" }); continue; }
    if (l.FieldName === null || !Object.hasOwn(LEGACY_LOG_FIELDS, l.FieldName)) { skipped.push({ logId: l.Id, reason: "unknown field" }); continue; }
    const wall = l.CreatedDateTime ?? l.LastUpdatedDateTime;
    const key = `${l.ActivityId}|${l.CreatedBy ?? ""}|${Math.floor(wall.getTime() / 1000)}`;
    const g = groups.get(key) ?? { rows: [], wall: new Date(Math.floor(wall.getTime() / 1000) * 1000) };
    g.rows.push(l);
    groups.set(key, g);
  }
  const entries: HistoryEntry[] = [];
  for (const { rows, wall } of groups.values()) {
    const first = rows[0]!;
    const fields = new Map<HistoryFieldKey, { key: HistoryFieldKey; old: string | null; new: string | null }>();
    for (const r of rows) {
      const k = LEGACY_LOG_FIELDS[r.FieldName!]!;
      const prev = fields.get(k);
      fields.set(k, { key: k, old: prev ? prev.old : display(k, r.OldValue, ctx), new: display(k, r.NewValue, ctx) });
    }
    entries.push({
      legacyKey: `log:${first.Id}`,
      activityId: first.ActivityId,
      logIds: rows.map((r) => r.Id),
      at: wallClockToInstant(wall, ctx.timeZone),
      actorId: ctx.userIdOf(first.CreatedBy),
      actorName: (ctx.actorNameOf(first.CreatedBy) ?? "").trim() || "Unknown legacy user",
      contactMinistryKey: ctx.contactMinistryKeyOf(first.ActivityId),
      fields: [...fields.values()],
    });
  }
  return { entries: entries.sort((a, b) => a.logIds[0]! - b.logIds[0]!), skipped };
}
