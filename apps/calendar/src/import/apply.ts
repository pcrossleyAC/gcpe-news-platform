import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { loadStored, replaceJoins, type JoinIds } from "../activities/store";
import {
  activities, categories, cities, commContacts, commMaterials, eventPlanners, favourites, governmentRepresentatives, initiatives, keywords,
  nrDistributions, nrOrigins, premierRequested, videographers,
} from "../db/schema";
import { LOOKUP_TABLES, type LegacySnapshot, type LookupTable } from "./legacy-rows";
import { mapLookup, type ActivityValues, type MappedActivity } from "./map";
import type { CalendarImportReport } from "./report";
import type { Scope } from "./scope";

const LOOKUP_TARGET = {
  categories, cities, commMaterials, eventPlanners, governmentRepresentatives, initiatives, keywords, nrDistributions, nrOrigins, premierRequested, videographers,
} as const satisfies Record<LookupTable, unknown>;

/** Every lookup, keeping legacy ids. Copied the first time only: lookup admin edits are never overwritten. */
export async function applyLookups(db: Db, s: LegacySnapshot, report: CalendarImportReport): Promise<void> {
  for (const t of LOOKUP_TABLES) {
    const table = LOOKUP_TARGET[t];
    report.legacy(`lookup:${t}`, s.lookups[t].length);
    for (const r of s.lookups[t]) {
      const rows = await db.insert(table).values(mapLookup(t, r) as never).onConflictDoNothing({ target: table.id }).returning({ id: table.id });
      report.count(`lookup:${t}`, rows.length ? "inserted" : "unchanged");
    }
  }
}

const rankOf = (n: number | null) => (n !== null && n >= 1 && n <= 6 ? n : null);

/**
 * In-scope comm contacts with their legacy ids. Active first, then by id, so two contacts of one
 * Core user and ministry (duplicate legacy emails) merge into the active, lowest-id one. Returns
 * legacy id → surviving Calendar contact id, or null when it wasn't imported.
 */
export async function applyCommContacts(db: Db, scope: Scope, userIdOf: (legacyId: number) => string | null, keys: LegacyKeys, report: CalendarImportReport): Promise<Map<number, number | null>> {
  const remap = new Map<number, number | null>();
  const ordered = [...scope.commContacts].sort((a, b) => Number(b.IsActive === true) - Number(a.IsActive === true) || a.Id - b.Id);
  for (const c of ordered) {
    const userId = userIdOf(c.SystemUserId);
    if (!userId) { report.skip("commContacts", String(c.Id), "its user wasn't imported"); remap.set(c.Id, null); continue; }
    if (c.MinistryId === null) { report.skip("commContacts", String(c.Id), "no ministry"); remap.set(c.Id, null); continue; }
    const ministryKey = keys.org(c.MinistryId)!.key;
    const [byId] = await db.select().from(commContacts).where(eq(commContacts.id, c.Id));
    if (byId) {
      if (byId.userId === userId && byId.ministryKey === ministryKey) { report.count("commContacts", "unchanged"); remap.set(c.Id, c.Id); }
      else { report.skip("commContacts", String(c.Id), "its id is held by another contact"); remap.set(c.Id, null); }
      continue;
    }
    const [byPair] = await db.select({ id: commContacts.id }).from(commContacts).where(and(eq(commContacts.userId, userId), eq(commContacts.ministryKey, ministryKey)));
    if (byPair) { report.skip("commContacts", String(c.Id), `merged into contact ${byPair.id} (same person and ministry)`); remap.set(c.Id, byPair.id); continue; }
    await db.insert(commContacts).values({ id: c.Id, userId, ministryKey, rank: rankOf(c.SortOrder), sortOrder: 0, isActive: c.IsActive === true });
    report.count("commContacts", "inserted");
    remap.set(c.Id, c.Id);
  }
  return remap;
}

/** A stable comparison of the columns the import writes and the join sets. */
export function fingerprintOf(values: Partial<ActivityValues>, joins: JoinIds): string {
  const v = Object.fromEntries(Object.keys(values).sort().map((k) => [k, (values as Record<string, unknown>)[k]]));
  return JSON.stringify([v, joins]);
}

/**
 * Activities by legacy id (spec addendum §12.1, safety 3): new ones inserted with imported_version 1;
 * one the Calendar changed since (version past imported_version), or created there (no
 * imported_version), skipped and listed; otherwise updated only when its legacy values moved.
 *
 * A newly inserted activity's favourites are inserted in the same transaction: a failure
 * later in the run can never leave an activity committed with its favourites lost, and a favourite
 * a user later removes in the Calendar is never resurrected by a re-run, because a re-run only
 * ever reaches this branch for an activity that isn't already present.
 */
export async function applyActivities(
  db: Db, list: MappedActivity[], favouritesByActivity: Map<number, { SystemUserId: number; ActivityId: number }[]>,
  userIdOf: (legacyId: number) => string | null, report: CalendarImportReport,
): Promise<{ inserted: Set<number>; present: Set<number> }> {
  const inserted = new Set<number>();
  const present = new Set<number>();
  for (const m of list) {
    const outcome = await db.transaction(async (tx) => {
      const [cur] = await tx.select({ version: activities.version, importedVersion: activities.importedVersion }).from(activities).where(eq(activities.id, m.id)).for("update");
      if (!cur) {
        await tx.insert(activities).values({ id: m.id, ...m.values, version: 1, importedVersion: 1 });
        await replaceJoins(tx, m.id, m.joins);
        for (const f of favouritesByActivity.get(m.id) ?? []) {
          const userId = userIdOf(f.SystemUserId);
          if (!userId) { report.skip("favourites", `${f.SystemUserId}/${f.ActivityId}`, "its user wasn't imported"); continue; }
          const rows = await tx.insert(favourites).values({ userId, activityId: f.ActivityId }).onConflictDoNothing().returning({ userId: favourites.userId });
          report.count("favourites", rows.length ? "inserted" : "unchanged");
        }
        return "inserted" as const;
      }
      if (cur.importedVersion === null) return "calendar-owned" as const;
      if (cur.version > cur.importedVersion) return "changed" as const;
      const stored = (await loadStored(tx, m.id))!;
      const storedValues = Object.fromEntries(Object.keys(m.values).map((k) => [k, (stored.row as Record<string, unknown>)[k]]));
      if (fingerprintOf(storedValues, stored.joins) === fingerprintOf(m.values, m.joins)) return "unchanged" as const;
      const next = cur.version + 1;
      await tx.update(activities).set({ ...m.values, version: next, importedVersion: next }).where(eq(activities.id, m.id));
      await replaceJoins(tx, m.id, m.joins);
      return "updated" as const;
    });
    if (outcome === "inserted") { inserted.add(m.id); present.add(m.id); report.count("activities", "inserted"); }
    else if (outcome === "updated" || outcome === "unchanged") { present.add(m.id); report.count("activities", outcome); }
    else if (outcome === "changed") { present.add(m.id); report.skip("activities", String(m.id), "changed in the Calendar since the last import"); report.listChangedInCalendar(m.id); }
    else { report.skip("activities", String(m.id), "its id is held by an activity created in the Calendar"); report.listChangedInCalendar(m.id); }
  }
  return { inserted, present };
}

const REBASED = [
  "activities", "categories", "cities", "comm_materials", "event_planners", "government_representatives", "initiatives", "keywords",
  "nr_distributions", "nr_origins", "premier_requested", "videographers", "comm_contacts", "saved_filters", "activity_files",
] as const;

/** Moves each legacy-id identity past the highest id, never lowering it (spec addendum §12.1 "Sequences"). */
export async function rebaseSequences(db: Db): Promise<void> {
  for (const t of REBASED) {
    const r = await db.execute<{ seq: string }>(sql`SELECT pg_get_serial_sequence(${t}, 'id') AS seq`);
    const seq = r.rows[0]!.seq;
    if (!/^[a-z_.]+$/.test(seq)) throw new Error("unexpected sequence name");
    await db.execute(sql.raw(`SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), (SELECT last_value FROM ${seq})), true)`));
  }
}
