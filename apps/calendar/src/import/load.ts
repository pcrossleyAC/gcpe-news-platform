import type { LegacySource } from "@gcpe/legacy-import";
import {
  JOIN_TABLES,
  LOOKUP_TABLES,
  type LegacyActivity,
  type LegacyCommContact,
  type LegacyFavourite,
  type LegacyFile,
  type LegacyJoinRow,
  type LegacyLog,
  type LegacyLookup,
  type LegacyReleaseLink,
  type LegacySavedFilter,
  type LegacySnapshot,
  type LegacyUser,
  type LegacyUserMinistry,
  type LookupTable,
} from "./legacy-rows";
import { Q } from "./queries";
import type { ScopeOptions } from "./scope";

const LOOKUP_QUERY: Record<LookupTable, keyof ReturnType<typeof Q>> = {
  categories: "lkCategories", cities: "lkCities", commMaterials: "lkCommMaterials", eventPlanners: "lkEventPlanners",
  governmentRepresentatives: "lkGovernmentRepresentatives", initiatives: "lkInitiatives", keywords: "lkKeywords",
  nrDistributions: "lkNrDistributions", nrOrigins: "lkNrOrigins", premierRequested: "lkPremierRequested", videographers: "lkVideographers",
};

/** Reads everything the import needs. The big tables are narrowed by the scope SQL; scope.ts decides. */
export async function loadLegacy(source: LegacySource, o: ScopeOptions): Promise<LegacySnapshot> {
  const q = Q(o.cutoff, o.awarenessCategoryIds);
  const count = async (sqlText: string) => Number((await source.query<{ N: number }>(sqlText))[0]?.N ?? 0);
  const joins = {} as LegacySnapshot["joins"];
  for (const t of JOIN_TABLES) joins[t] = await source.query<LegacyJoinRow & Record<string, unknown>>(q[t]);
  const lookups = {} as LegacySnapshot["lookups"];
  for (const t of LOOKUP_TABLES) lookups[t] = await source.query<LegacyLookup & Record<string, unknown>>(q[LOOKUP_QUERY[t]]);
  return {
    activities: await source.query<LegacyActivity & Record<string, unknown>>(q.activities),
    joins,
    users: await source.query<LegacyUser & Record<string, unknown>>(q.users),
    userMinistries: await source.query<LegacyUserMinistry & Record<string, unknown>>(q.userMinistries),
    commContacts: await source.query<LegacyCommContact & Record<string, unknown>>(q.commContacts),
    savedFilters: await source.query<LegacySavedFilter & Record<string, unknown>>(q.savedFilters),
    favourites: await source.query<LegacyFavourite & Record<string, unknown>>(q.favourites),
    files: await source.query<LegacyFile & Record<string, unknown>>(q.files),
    logs: await source.query<LegacyLog & Record<string, unknown>>(q.logs),
    lookups,
    releaseLinks: await source.query<LegacyReleaseLink & Record<string, unknown>>(q.releaseLinks),
    totals: { activities: await count(q.activityCount), favourites: await count(q.favouriteCount), files: await count(q.fileCount), logs: await count(q.logCount) },
  };
}
