import { isNotNull } from "drizzle-orm";
import type { CalendarRole } from "@gcpe/auth";
import type { Db } from "@gcpe/db-kit";
import { organizations, terms } from "../db/schema";

export interface LegacyOrg { id: string; key: string; displayName: string; abbreviation: string | null }
/** Legacy dbo GUIDs (Ministry, Sector, Theme, Tag) as Core knows them: Core stores them lowercased. */
export interface LegacyKeys {
  org(guid: string): LegacyOrg | null;
  termKey(kind: "sector" | "theme" | "tag", guid: string): string | null;
}

export async function loadLegacyKeys(db: Db): Promise<LegacyKeys> {
  const orgRows = await db.select({ id: organizations.id, key: organizations.key, displayName: organizations.displayName, abbreviation: organizations.abbreviation, legacyId: organizations.legacyId }).from(organizations).where(isNotNull(organizations.legacyId));
  const termRows = await db.select({ kind: terms.kind, key: terms.key, legacyId: terms.legacyId }).from(terms).where(isNotNull(terms.legacyId));
  const orgs = new Map(orgRows.map((o) => [o.legacyId!.toLowerCase(), { id: o.id, key: o.key, displayName: o.displayName, abbreviation: o.abbreviation }]));
  const termMap = new Map(termRows.map((t) => [`${t.kind}:${t.legacyId!.toLowerCase()}`, t.key]));
  return {
    org: (guid) => orgs.get(guid.trim().toLowerCase()) ?? null,
    termKey: (kind, guid) => termMap.get(`${kind}:${guid.trim().toLowerCase()}`) ?? null,
  };
}

/** One legacy calendar.SystemUser, ready for Core (spec addendum §12.1 step 1). */
export interface CalendarUserCandidate {
  legacyId: number;
  /** As legacy holds it; normalised and validated by the planner. */
  email: string | null;
  displayName: string;
  /** Legacy IsActive. */
  isActive: boolean;
  calendarRole: CalendarRole | null;
  /** Core organization ids of the user's active legacy ministries. */
  organizationIds: string[];
  /** Legacy LastUpdatedDateTime in ms (0 when null): picks one row among duplicate emails. */
  lastUpdated: number;
}
