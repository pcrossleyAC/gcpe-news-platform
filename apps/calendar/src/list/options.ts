import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ListOption, ListOptions } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { commContacts, orgs, users } from "../db/schema";
import { listLookupRows, LOOKUPS, type LookupDef } from "../lookups";

const activeOf = async (db: DbOrTx, def: LookupDef): Promise<ListOption[]> =>
  (await listLookupRows(db, def)).filter((r) => r.isActive).map((r) => ({ id: r.id, name: r.name }));

/** The filter panel's choices (Default.aspx.cs:55-140): HQ chooses among every active ministry, others among their own. */
export async function listOptions(db: DbOrTx, actor: CalendarActor): Promise<ListOptions> {
  const keys = actor.ministryKeys;
  const scope = actor.isHq ? undefined : keys.length ? inArray(commContacts.ministryKey, keys) : sql`false`;
  return {
    categories: await activeOf(db, LOOKUPS.categories),
    keywords: await activeOf(db, LOOKUPS.keywords),
    representatives: await activeOf(db, LOOKUPS["government-representatives"]),
    initiatives: await activeOf(db, LOOKUPS.initiatives),
    premierRequested: await activeOf(db, LOOKUPS["premier-requested"]),
    distributions: await activeOf(db, LOOKUPS["nr-distributions"]),
    ministries: (
      await db
        .select({ key: orgs.key, abbreviation: orgs.abbreviation, name: orgs.displayName })
        .from(orgs)
        .where(actor.isHq ? eq(orgs.isActive, true) : keys.length ? inArray(orgs.key, keys) : sql`false`)
        .orderBy(asc(orgs.abbreviation), asc(orgs.key))
    ),
    commContacts: await db
      .selectDistinct({ userId: commContacts.userId, name: users.displayName })
      .from(commContacts)
      .innerJoin(users, eq(users.id, commContacts.userId))
      .where(and(eq(commContacts.isActive, true), eq(users.isActive, true), scope))
      .orderBy(asc(users.displayName), asc(commContacts.userId)),
  };
}
