import { and, asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EventEnvelope, EventHandler, OrgRecord, TermRecord } from "@gcpe/events";
import { categoryTerms, organizations } from "./db/schema";

const TERM_KIND = { sector: "sectors", theme: "themes", tag: "tags" } as const;
type TermKindSingular = keyof typeof TERM_KIND;

const upsertOrg: EventHandler = async (tx, e) => {
  const o = e.data as OrgRecord;
  const row = { key: o.key.toLowerCase(), displayName: o.displayName, abbreviation: o.abbreviation, sortOrder: o.sortOrder, isActive: o.isActive };
  await tx.insert(organizations).values(row).onConflictDoUpdate({ target: organizations.key, set: row });
};
const deactivateOrg: EventHandler = async (tx, e) => {
  await tx.update(organizations).set({ isActive: false }).where(eq(organizations.key, (e.data as { key: string }).key.toLowerCase()));
};
const upsertTerm: EventHandler = async (tx, e) => {
  const t = e.data as TermRecord;
  const kind = TERM_KIND[t.kind as TermKindSingular];
  const row = { kind, key: t.key.toLowerCase(), displayName: t.displayName ?? t.key, sortOrder: t.sortOrder, isActive: t.isActive };
  await tx.insert(categoryTerms).values(row).onConflictDoUpdate({ target: [categoryTerms.kind, categoryTerms.key], set: row });
};
const deactivateTerm: EventHandler = async (tx, e) => {
  const d = e.data as { kind: TermKindSingular; key: string };
  await tx.update(categoryTerms).set({ isActive: false }).where(and(eq(categoryTerms.kind, TERM_KIND[d.kind]), eq(categoryTerms.key, d.key.toLowerCase())));
};

/** Core's org/sector/theme/tag events → the local cache. Anything else is left to the receiver ("ignored"). */
export function taxonomyHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source !== "core") return undefined;
  switch (event.type) {
    case "org.upserted":
      return upsertOrg;
    case "org.deactivated":
      return deactivateOrg;
    case "sector.upserted":
    case "theme.upserted":
    case "tag.upserted":
      return upsertTerm;
    case "sector.deactivated":
    case "theme.deactivated":
    case "tag.deactivated":
      return deactivateTerm;
    default:
      return undefined;
  }
}

export interface Categories {
  ministries: { key: string; name: string; abbreviation: string | null }[];
  sectors: { key: string; name: string }[];
  themes: { key: string; name: string }[];
  tags: { key: string; name: string }[];
}

export async function listCategories(db: DbOrTx): Promise<Categories> {
  const orgs = await db.select().from(organizations).where(eq(organizations.isActive, true)).orderBy(asc(organizations.sortOrder), asc(organizations.displayName));
  const terms = await db.select().from(categoryTerms).where(eq(categoryTerms.isActive, true)).orderBy(asc(categoryTerms.sortOrder), asc(categoryTerms.displayName));
  const of = (kind: "sectors" | "themes" | "tags") => terms.filter((t) => t.kind === kind).map((t) => ({ key: t.key, name: t.displayName }));
  return { ministries: orgs.map((o) => ({ key: o.key, name: o.displayName, abbreviation: o.abbreviation })), sectors: of("sectors"), themes: of("themes"), tags: of("tags") };
}

/** Includes inactive ministries, so an old release can still be numbered/rendered. */
export async function ministryAbbreviation(db: DbOrTx, key: string): Promise<string | null> {
  const [row] = await db.select({ a: organizations.abbreviation }).from(organizations).where(sql`${organizations.key} = ${key.toLowerCase()}`);
  return row?.a ?? null;
}

export async function ministryName(db: DbOrTx, key: string): Promise<string | null> {
  const [row] = await db.select({ n: organizations.displayName }).from(organizations).where(sql`${organizations.key} = ${key.toLowerCase()}`);
  return row?.n ?? null;
}
