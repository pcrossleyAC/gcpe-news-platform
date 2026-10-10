import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EditorOption, EditorOptions, EditorTerm } from "@gcpe/calendar-contract";
import { commContacts, orgs, terms, users, type TermKind } from "../db/schema";
import { listLookupRows, LOOKUPS, type LookupDef } from "../lookups";

const rowsOf = async (db: DbOrTx, def: LookupDef): Promise<EditorOption[]> =>
  (await listLookupRows(db, def)).map((r) => ({ id: r.id, name: r.name, isActive: r.isActive }));

/** Every lookup, ministry, term and comm contact, inactive ones flagged (spec addendum §8.2; DropDownListManager.cs:297). */
export async function editorOptions(db: DbOrTx): Promise<EditorOptions> {
  const termRows = await db.select().from(terms).orderBy(asc(terms.sortOrder), asc(terms.displayName), asc(terms.key));
  const termsOf = (kind: TermKind): EditorTerm[] => termRows.filter((t) => t.kind === kind).map((t) => ({ key: t.key, name: t.displayName, isActive: t.isActive }));
  const contacts = await db
    .select({ id: commContacts.id, ministryKey: commContacts.ministryKey, name: users.displayName, rank: commContacts.rank, contactActive: commContacts.isActive, userActive: users.isActive })
    .from(commContacts)
    .leftJoin(users, eq(users.id, commContacts.userId))
    .orderBy(asc(commContacts.sortOrder), asc(users.displayName), asc(commContacts.id));
  return {
    categories: await rowsOf(db, LOOKUPS.categories),
    cities: await rowsOf(db, LOOKUPS.cities),
    commMaterials: await rowsOf(db, LOOKUPS["comm-materials"]),
    eventPlanners: await rowsOf(db, LOOKUPS["event-planners"]),
    representatives: await rowsOf(db, LOOKUPS["government-representatives"]),
    initiatives: (await listLookupRows(db, LOOKUPS.initiatives)).map((r) => ({ id: r.id, name: r.name, isActive: r.isActive, shortName: r.extras.shortName ?? null })),
    keywords: await rowsOf(db, LOOKUPS.keywords),
    distributions: await rowsOf(db, LOOKUPS["nr-distributions"]),
    origins: await rowsOf(db, LOOKUPS["nr-origins"]),
    premierRequested: await rowsOf(db, LOOKUPS["premier-requested"]),
    videographers: await rowsOf(db, LOOKUPS.videographers),
    ministries: await db
      .select({ key: orgs.key, abbreviation: orgs.abbreviation, name: orgs.displayName, isActive: orgs.isActive })
      .from(orgs)
      .orderBy(asc(orgs.abbreviation), asc(orgs.key)),
    commContacts: contacts.map((c) => ({ id: c.id, ministryKey: c.ministryKey, name: c.name ?? "Unknown", rank: c.rank, isActive: c.contactActive && c.userActive === true })),
    sectors: termsOf("sector"),
    themes: termsOf("theme"),
    tags: termsOf("tag"),
  };
}
