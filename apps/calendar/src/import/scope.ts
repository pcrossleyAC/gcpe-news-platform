import { JOIN_TABLES, type JoinTable, type LegacyActivity, type LegacyCommContact, type LegacyFavourite, type LegacyFile, type LegacyJoinRow, type LegacyLog, type LegacySavedFilter, type LegacySnapshot } from "./legacy-rows";

export interface ScopeOptions { cutoff: string; awarenessCategoryIds: readonly number[] }
export interface Scope {
  /** In scope, by id. */
  activities: LegacyActivity[];
  activityIds: Set<number>;
  joins: Record<JoinTable, LegacyJoinRow[]>;
  commContacts: LegacyCommContact[];
  savedFilters: LegacySavedFilter[];
  favourites: LegacyFavourite[];
  files: LegacyFile[];
  logs: LegacyLog[];
  /** Legacy SystemUser ids to import (spec addendum §12.1 step 1). */
  userIds: Set<number>;
  outOfScope: { activities: number; favourites: number; files: number; logs: number; releaseLinks: number; releaseLinksInScope: number };
}

/** The cutoff date's 00:00 as a wall-clock instant, comparable with legacy DATETIMEs (BC wall-clock in their UTC fields). */
export function cutoffWallMs(cutoff: string): number {
  const [y, m, d] = cutoff.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Ends on or after the cutoff, or starts on or after it. Either date counts, so an activity that ends before it starts still comes. */
export function isPostCutoff(a: Pick<LegacyActivity, "StartDateTime" | "EndDateTime">, cutoffMs: number): boolean {
  return (a.EndDateTime !== null && a.EndDateTime.getTime() >= cutoffMs) || (a.StartDateTime !== null && a.StartDateTime.getTime() >= cutoffMs);
}

export function selectScope(s: LegacySnapshot, o: ScopeOptions): Scope {
  const cut = cutoffWallMs(o.cutoff);
  const awareness = new Set(s.joins.categories.filter((r) => r.IsActive === true && o.awarenessCategoryIds.includes(Number(r.ValueId))).map((r) => r.ActivityId));
  const activities = s.activities
    .filter((a) => isPostCutoff(a, cut) || (a.IsActive === true && awareness.has(a.Id)))
    .sort((a, b) => a.Id - b.Id);
  const activityIds = new Set(activities.map((a) => a.Id));

  const joins = {} as Scope["joins"];
  for (const t of JOIN_TABLES) {
    const seen = new Set<string>();
    joins[t] = s.joins[t].filter((r) => {
      const key = `${r.ActivityId}|${String(r.ValueId).toLowerCase()}`;
      if (r.IsActive !== true || !activityIds.has(r.ActivityId) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const referencedContacts = new Set(activities.map((a) => a.CommunicationContactId).filter((id): id is number => id !== null));
  const commContacts = s.commContacts.filter((c) => c.IsActive === true || referencedContacts.has(c.Id)).sort((a, b) => a.Id - b.Id);
  const savedFilters = s.savedFilters.filter((f) => f.IsActive === true).sort((a, b) => a.Id - b.Id);
  const favourites = s.favourites.filter((f) => activityIds.has(f.ActivityId));
  const files = s.files.filter((f) => activityIds.has(f.ActivityId)).sort((a, b) => a.Id - b.Id);
  const logs = s.logs.filter((l) => activityIds.has(l.ActivityId)).sort((a, b) => a.Id - b.Id);

  const userIds = new Set<number>(s.users.filter((u) => u.IsActive === true).map((u) => u.Id));
  const add = (id: number | null) => void (id !== null && userIds.add(id));
  for (const a of activities) { add(a.CreatedBy); add(a.LastUpdatedBy); }
  for (const c of commContacts) add(c.SystemUserId);
  for (const f of savedFilters) add(f.CreatedBy);
  for (const f of favourites) add(f.SystemUserId);
  const known = new Set(s.users.map((u) => u.Id));
  for (const id of [...userIds]) if (!known.has(id)) userIds.delete(id);

  const inLinks = s.releaseLinks.filter((r) => activityIds.has(r.ActivityId)).reduce((n, r) => n + Number(r.N), 0);
  const allLinks = s.releaseLinks.reduce((n, r) => n + Number(r.N), 0);
  return {
    activities, activityIds, joins, commContacts, savedFilters, favourites, files, logs, userIds,
    outOfScope: {
      activities: s.totals.activities - activities.length,
      favourites: s.totals.favourites - favourites.length,
      files: s.totals.files - files.length,
      logs: s.totals.logs - logs.length,
      releaseLinks: allLinks - inLinks,
      releaseLinksInScope: inLinks,
    },
  };
}
