import type { Db } from "@gcpe/db-kit";
import type { LegacyKeyRows } from "../../apps/calendar/src/import/csv-snapshot";
import { HQ_ABBREVIATIONS, upsertOrganization } from "../../apps/core/src/services/organizations";
import { upsertTerm } from "../../apps/core/src/services/terms";
import { healthOrg } from "../../apps/core/test/helpers";

const SOCIAL = { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null };
const HQ = new Set<string>(HQ_ABBREVIATIONS);

/**
 * Fills a throwaway Core (the report parity check's own database, never a real one) with legacy's
 * ministries, sectors, themes and tags under their legacy GUIDs and keys, so the importer's key
 * check passes. The organisation template is the fictional healthOrg. Returns the GCPEHQ key.
 */
export async function seedCoreFromLegacyKeys(coreDb: Db, keys: LegacyKeyRows): Promise<string> {
  const hq = keys.ministries.filter((m) => (m.Abbreviation ?? "").toUpperCase() === "GCPEHQ");
  if (hq.length !== 1) throw new Error(`expected one GCPEHQ ministry, found ${hq.length}`);
  for (const [i, m] of keys.ministries.entries()) {
    const abbreviation = m.Abbreviation;
    await upsertOrganization(
      coreDb,
      { ...healthOrg, key: m.Key, displayName: m.DisplayName, abbreviation, sortOrder: i, isActive: m.IsActive, sectorKeys: [] },
      [],
      { legacyId: m.Id.toLowerCase(), isHqOnCreate: HQ.has((abbreviation ?? "").toUpperCase()) },
    );
  }
  for (const [kind, rows] of [["sector", keys.sectors], ["theme", keys.themes], ["tag", keys.tags]] as const) {
    for (const [i, t] of rows.entries()) {
      await upsertTerm(coreDb, { kind, key: t.Key, displayName: t.DisplayName, sortOrder: t.SortOrder ?? i, isActive: t.IsActive, social: SOCIAL }, [], { legacyId: t.Id.toLowerCase() });
    }
  }
  return hq[0]!.Key;
}
