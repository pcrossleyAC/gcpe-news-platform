import type { Db } from "@gcpe/db-kit";
import type { SubscriberConfig, TermKind } from "@gcpe/events";
import type { LegacySource } from "@gcpe/legacy-import";
import { isHqAbbreviation, isNonPublicAbbreviation, upsertOrganization } from "../services/organizations";
import { upsertTerm } from "../services/terms";
import { mapMinistry, mapTerm, type LegacyLinkRow, type LegacyMinistryRow, type LegacyMinistrySectorRow, type LegacyTermRow } from "./map";
import { Q_MINISTRIES, Q_MINISTRY_SECTORS, Q_MINISTRY_SERVICES, Q_MINISTRY_TOPICS, Q_SECTORS, Q_SERVICES, Q_TAGS, Q_THEMES } from "./queries";

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
  return map;
}

const norm = (id: string) => id.toLowerCase();

export async function importLegacyReference(db: Db, source: LegacySource, subscribers: SubscriberConfig[]) {
  const result = { organizations: { total: 0, changed: 0 }, terms: { total: 0, changed: 0 } };

  const termQueries: [TermKind, string][] = [
    ["sector", Q_SECTORS],
    ["theme", Q_THEMES],
    ["tag", Q_TAGS],
    ["service", Q_SERVICES],
  ];
  for (const [kind, q] of termQueries) {
    for (const row of await source.query<LegacyTermRow>(q)) {
      const { changed } = await upsertTerm(db, mapTerm(kind, row), subscribers, { legacyId: norm(row.Id) });
      result.terms.total++;
      if (changed) result.terms.changed++;
    }
  }

  const ministries = await source.query<LegacyMinistryRow>(Q_MINISTRIES);
  const topics = groupBy(await source.query<LegacyLinkRow>(Q_MINISTRY_TOPICS), (r) => norm(r.MinistryId));
  const services = groupBy(await source.query<LegacyLinkRow>(Q_MINISTRY_SERVICES), (r) => norm(r.MinistryId));
  const sectors = groupBy(await source.query<LegacyMinistrySectorRow>(Q_MINISTRY_SECTORS), (r) => norm(r.MinistryId));
  for (const row of ministries) {
    const id = norm(row.Id);
    const org = mapMinistry(row, {
      topics: topics.get(id) ?? [],
      services: services.get(id) ?? [],
      sectorKeys: (sectors.get(id) ?? []).map((s) => s.SectorKey),
    });
    // GCPEHQ, GCPEMEDIA and PREM are created HQ (Q49), and GCPEHQ and GCPEMEDIA non-public (Q54);
    // an existing organization keeps Core.Admin's flags (C124).
    const { changed } = await upsertOrganization(db, org, subscribers, {
      legacyId: id,
      isHqOnCreate: isHqAbbreviation(row.Abbreviation),
      isPublicOnCreate: !isNonPublicAbbreviation(row.Abbreviation),
    });
    result.organizations.total++;
    if (changed) result.organizations.changed++;
  }
  return result;
}
