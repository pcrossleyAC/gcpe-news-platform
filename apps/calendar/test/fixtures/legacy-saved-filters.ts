import type { LegacyFilterResolver, LegacySavedFilterRow } from "../../src/list/legacy-filters";

/** Fictional legacy users and a fictional ministry GUID; no legacy data. */
export const LEGACY_OWNER_A = 7001;
export const LEGACY_OWNER_B = 7002;
export const OWNER_A = "00000000-0000-4000-8000-000000000701";
export const OWNER_B = "00000000-0000-4000-8000-000000000702";
export const HEALTH_GUID = "1C6D5A10-0000-4000-8000-00000000000A";

export const LEGACY_SAVED_FILTERS: LegacySavedFilterRow[] = [
  { id: 501, createdBy: LEGACY_OWNER_A, name: "Sample health this month", sortOrder: 1, isActive: true,
    queryString: `status=1|category=12|ministry=${HEALTH_GUID}|datefrom=10/01/2026|dateto=10/31/2026|keywords=1~2|isissue=true|dateConfirmed=false|display=2|thisdayonly=false|lookahead=true|quickSearch=sample launch` },
  { id: 502, createdBy: LEGACY_OWNER_B, name: "Sample stale", sortOrder: 1, isActive: true,
    queryString: "ActivityListProvider.aspx?contact=7001&representative=1&premierRequested=2&distribution=1&initiative=1" },
  { id: 503, createdBy: LEGACY_OWNER_A, name: "Sample deleted", sortOrder: 2, isActive: false, queryString: "status=7" },
  { id: 504, createdBy: 9999, name: "Sample orphan", sortOrder: 1, isActive: true, queryString: "status=2" },
  { id: 505, createdBy: LEGACY_OWNER_B, name: "Sample odd one", sortOrder: 2, isActive: true,
    queryString: "status=5|category=-2|ministry=FFFFFFFF-0000-4000-8000-00000000000F|datefrom=13/45/2026|keywords=1~x|colour=blue|representative=*|initiative=" },
  { id: 506, createdBy: LEGACY_OWNER_A, name: null, sortOrder: null, isActive: true, queryString: "" },
  { id: 507, createdBy: LEGACY_OWNER_B, name: "Sample backwards", sortOrder: 3, isActive: true, queryString: "datefrom=12/01/2026|dateto=11/01/2026|category=999" },
  { id: 508, createdBy: LEGACY_OWNER_A, name: "Sample equals", sortOrder: 3, isActive: true, queryString: "quickSearch=a=b|status=2" },
];

export const LEGACY_RESOLVER: LegacyFilterResolver = {
  ministryKeyOf: (guid) => (guid === HEALTH_GUID ? "health" : null),
  userIdOf: (legacyId) => (legacyId === LEGACY_OWNER_A ? OWNER_A : legacyId === LEGACY_OWNER_B ? OWNER_B : null),
};
