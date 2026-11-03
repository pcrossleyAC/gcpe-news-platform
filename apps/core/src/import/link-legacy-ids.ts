import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { SubscriberConfig, TermKind } from "@gcpe/events";
import type { LegacySource } from "@gcpe/legacy-import";
import { organizations, terms } from "../db/schema";
import { upsertOrganization } from "../services/organizations";
import { upsertTerm } from "../services/terms";
import { mapMinistry, mapTerm, type LegacyMinistryRow, type LegacyTermRow } from "./map";
import { Q_MINISTRIES, Q_SECTORS, Q_TAGS, Q_THEMES } from "./queries";

/**
 * Gives a Core that was set up another way (a test host seeded without Core's legacy import) the
 * legacy ids the Calendar import maps by (legacy-keys.ts), changing no organization's or term's
 * content: an existing one with the same key, and no legacy id yet, gets legacy's id; a legacy one
 * Core lacks is added as an inactive placeholder (an organization also non-public, no parent),
 * through Core's own upsert so the other apps hear of it. An existing one that already holds a
 * different legacy id is reported and left alone. Core's real legacy import (run.ts) remains the
 * cutover step: it also copies legacy's content.
 */
export interface LegacyReference {
  ministries: LegacyMinistryRow[];
  terms: { kind: Exclude<TermKind, "service">; row: LegacyTermRow }[];
}

export async function readLegacyReference(source: LegacySource): Promise<LegacyReference> {
  const termRows: LegacyReference["terms"] = [];
  for (const [kind, q] of [["sector", Q_SECTORS], ["theme", Q_THEMES], ["tag", Q_TAGS]] as const) {
    for (const row of await source.query<LegacyTermRow>(q)) termRows.push({ kind, row });
  }
  return { ministries: await source.query<LegacyMinistryRow>(Q_MINISTRIES), terms: termRows };
}

export interface LinkReport {
  mode: "dry-run" | "confirmed";
  /** Existing, keys matched: legacy id recorded (or, in a dry run, would be). */
  linked: { organizations: number; terms: number };
  /** Already held exactly this legacy id. */
  alreadyLinked: { organizations: number; terms: number };
  /** Added as inactive placeholders (or would be). */
  created: { organizations: string[]; terms: string[] };
  /** Held another legacy id: left alone, by kind and key. */
  conflicts: string[];
  /** Of `linked`, the ministries matched by abbreviation, as "legacy key -> Core key". */
  linkedByAbbreviation: string[];
}

const norm = (id: string) => id.toLowerCase();

export async function linkLegacyIds(db: Db, ref: LegacyReference, subscribers: SubscriberConfig[], confirm: boolean): Promise<LinkReport> {
  const report: LinkReport = { mode: confirm ? "confirmed" : "dry-run", linked: { organizations: 0, terms: 0 }, alreadyLinked: { organizations: 0, terms: 0 }, created: { organizations: [], terms: [] }, conflicts: [], linkedByAbbreviation: [] };

  // Matched by key ignoring case (legacy's GUID-shaped keys are upper-case where a seeded Core's are
  // not; the exact key wins when both exist). A legacy ministry no key matches is then matched by
  // abbreviation, only to an organization no key matched and holding no legacy id, and only when
  // the abbreviation is unique on both sides (a seeded "gcpe-headquarters" is legacy's GUID-keyed GCPEHQ).
  const orgRows = await db.select({ key: organizations.key, legacyId: organizations.legacyId, abbreviation: organizations.abbreviation }).from(organizations);
  const orgKeyFor = (key: string) => orgRows.find((o) => o.key === key)?.key ?? orgRows.find((o) => o.key.toLowerCase() === key.toLowerCase())?.key;
  const orgs = new Map(orgRows.map((o) => [o.key, o.legacyId]));
  const byKey = new Map(ref.ministries.map((row) => [row, orgKeyFor(row.Key)]));
  const keyMatched = new Set([...byKey.values()].filter((k): k is string => k !== undefined));
  const abbr = (a: string | null | undefined) => (a ?? "").trim().toUpperCase();
  const count = <T,>(items: T[], of: (t: T) => string) => items.reduce((m, t) => m.set(of(t), (m.get(of(t)) ?? 0) + 1), new Map<string, number>());
  const legacyAbbr = count(ref.ministries, (r) => abbr(r.Abbreviation));
  const coreAbbr = count(orgRows, (o) => abbr(o.abbreviation));
  const byAbbreviation = (row: LegacyMinistryRow): string | undefined => {
    const a = abbr(row.Abbreviation);
    if (!a || legacyAbbr.get(a) !== 1 || coreAbbr.get(a) !== 1) return undefined;
    const org = orgRows.find((o) => abbr(o.abbreviation) === a);
    return org && !keyMatched.has(org.key) && org.legacyId === null ? org.key : undefined;
  };
  for (const row of ref.ministries) {
    const id = norm(row.Id);
    const viaAbbreviation = byKey.get(row) === undefined ? byAbbreviation(row) : undefined;
    const key = byKey.get(row) ?? viaAbbreviation;
    if (key === undefined) {
      report.created.organizations.push(row.Key);
      if (confirm) {
        const org = { ...mapMinistry(row, { topics: [], services: [], sectorKeys: [] }), isActive: false, parentKey: null };
        await upsertOrganization(db, org, subscribers, { legacyId: id, isPublicOnCreate: false, isHqOnCreate: false });
      }
      continue;
    }
    if (viaAbbreviation) report.linkedByAbbreviation.push(`${row.Key} -> ${viaAbbreviation}`);
    const held = orgs.get(key);
    if (held && norm(held) === id) report.alreadyLinked.organizations++;
    else if (held) report.conflicts.push(`ministry ${key}`);
    else {
      report.linked.organizations++;
      if (confirm) await db.update(organizations).set({ legacyId: id }).where(and(eq(organizations.key, key), isNull(organizations.legacyId)));
    }
  }

  const termRows = await db.select({ kind: terms.kind, key: terms.key, legacyId: terms.legacyId }).from(terms);
  const termKeyFor = (kind: string, key: string) =>
    termRows.find((t) => t.kind === kind && t.key === key)?.key ?? termRows.find((t) => t.kind === kind && t.key.toLowerCase() === key.toLowerCase())?.key;
  const termsHeld = new Map(termRows.map((t) => [`${t.kind}:${t.key}`, t.legacyId]));
  for (const { kind, row } of ref.terms) {
    const id = norm(row.Id);
    const key = termKeyFor(kind, row.Key);
    const k = `${kind}:${key ?? row.Key}`;
    if (key === undefined) {
      report.created.terms.push(k);
      if (confirm) await upsertTerm(db, { ...mapTerm(kind, row), isActive: false }, subscribers, { legacyId: id });
      continue;
    }
    const held = termsHeld.get(k);
    if (held && norm(held) === id) report.alreadyLinked.terms++;
    else if (held) report.conflicts.push(`${kind} ${row.Key}`);
    else {
      report.linked.terms++;
      if (confirm) await db.update(terms).set({ legacyId: id }).where(and(eq(terms.kind, kind), eq(terms.key, key), isNull(terms.legacyId)));
    }
  }
  return report;
}
