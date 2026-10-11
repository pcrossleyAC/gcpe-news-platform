import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ListRow } from "@gcpe/calendar-contract";
import { can } from "../capabilities";
import {
  activities, activityCategories, activityCommMaterials, activityKeywords, activityNrOrigins, activitySharedWith, categories, cities, commContacts, commMaterials,
  eventPlanners, favourites, governmentRepresentatives, keywords, nrDistributions, nrOrigins, orgs, premierRequested, releaseLinks, userProfiles, users,
} from "../db/schema";
import { visibleSql, type VisibilityFacts } from "../visibility";
import type { ListScope } from "./query";

const contactUser = alias(users, "contact_user");
const updater = alias(users, "updater");
/** Ids per round trip: far below Postgres's parameter limit. */
const CHUNK = 1000;

/** Each id's values, in the query's order. */
export async function grouped<V>(q: Promise<{ id: number; v: V }[]>): Promise<Map<number, V[]>> {
  const out = new Map<number, V[]>();
  for (const r of await q) out.set(r.id, [...(out.get(r.id) ?? []), r.v]);
  return out;
}
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** A list row with the activity record it was built from, for readers that print more than the list. */
export interface RowWithFacts {
  row: ListRow;
  activity: typeof activities.$inferSelect;
  /** `can.seeLookAheadFieldset` for this viewer and row: where the Look Ahead fields show. */
  seesLookAhead: boolean;
}

/** The list's rows for these ids, in this order. Still filtered by visibleSql: a row never carries an activity the caller can't see. */
export async function rowsOf(tx: DbOrTx, scope: ListScope, ids: readonly number[]): Promise<ListRow[]> {
  return (await rowsWithFactsOf(tx, scope, ids)).map((r) => r.row);
}

/** rowsOf's rows, each with its activity record and whether the viewer sees its Look Ahead fields. */
export async function rowsWithFactsOf(tx: DbOrTx, scope: ListScope, ids: readonly number[]): Promise<RowWithFacts[]> {
  const out: RowWithFacts[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await chunk(tx, scope, ids.slice(i, i + CHUNK))));
  return out;
}

async function chunk(tx: DbOrTx, scope: ListScope, ids: number[]): Promise<RowWithFacts[]> {
  if (ids.length === 0) return [];
  const { actor, rules } = scope;
  const base = await tx
    .select({
      a: activities,
      ministryAbbreviation: orgs.abbreviation,
      cityName: cities.name,
      representative: governmentRepresentatives.name,
      premier: premierRequested.name,
      distribution: nrDistributions.name,
      eventPlanner: eventPlanners.name,
      contactName: contactUser.displayName,
      contactPhone: userProfiles.phone,
      updaterName: updater.displayName,
    })
    .from(activities)
    .leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey))
    .leftJoin(cities, eq(cities.id, activities.cityId))
    .leftJoin(governmentRepresentatives, eq(governmentRepresentatives.id, activities.governmentRepresentativeId))
    .leftJoin(premierRequested, eq(premierRequested.id, activities.premierRequestedId))
    .leftJoin(nrDistributions, eq(nrDistributions.id, activities.nrDistributionId))
    .leftJoin(eventPlanners, eq(eventPlanners.id, activities.eventPlannerId))
    .leftJoin(commContacts, eq(commContacts.id, activities.commContactId))
    .leftJoin(contactUser, eq(contactUser.id, commContacts.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, commContacts.userId))
    .leftJoin(updater, eq(updater.id, activities.lastUpdatedBy))
    .where(and(inArray(activities.id, ids), visibleSql(actor)));
  const cats = await grouped(tx.select({ id: activityCategories.activityId, v: categories.name }).from(activityCategories).innerJoin(categories, eq(categories.id, activityCategories.categoryId)).where(inArray(activityCategories.activityId, ids)).orderBy(asc(categories.name)));
  const materials = await grouped(tx.select({ id: activityCommMaterials.activityId, v: commMaterials.name }).from(activityCommMaterials).innerJoin(commMaterials, eq(commMaterials.id, activityCommMaterials.commMaterialId)).where(inArray(activityCommMaterials.activityId, ids)).orderBy(asc(commMaterials.name)));
  const kws = await grouped(tx.select({ id: activityKeywords.activityId, v: keywords.name }).from(activityKeywords).innerJoin(keywords, eq(keywords.id, activityKeywords.keywordId)).where(inArray(activityKeywords.activityId, ids)).orderBy(asc(keywords.name)));
  const origins = await grouped(tx.select({ id: activityNrOrigins.activityId, v: nrOrigins.name }).from(activityNrOrigins).innerJoin(nrOrigins, eq(nrOrigins.id, activityNrOrigins.nrOriginId)).where(inArray(activityNrOrigins.activityId, ids)).orderBy(asc(nrOrigins.name)));
  const watchers = await grouped(tx.select({ id: favourites.activityId, v: users.displayName }).from(favourites).innerJoin(users, eq(users.id, favourites.userId)).where(inArray(favourites.activityId, ids)).orderBy(asc(users.displayName)));
  const sharedKeys = await grouped(tx.select({ id: activitySharedWith.activityId, v: activitySharedWith.ministryKey }).from(activitySharedWith).where(inArray(activitySharedWith.activityId, ids)));
  const shared = new Set(sharedKeys.keys());
  const released = new Set((await tx.selectDistinct({ id: releaseLinks.activityId }).from(releaseLinks).where(inArray(releaseLinks.activityId, ids))).map((r) => r.id));
  const mine = new Set((await tx.select({ id: favourites.activityId }).from(favourites).where(and(inArray(favourites.activityId, ids), eq(favourites.userId, actor.userId)))).map((r) => r.id));
  const markup = can.seeListMarkup(actor);
  const byId = new Map(base.map((r) => [r.a.id, r]));
  return ids.flatMap((id): RowWithFacts[] => {
    const r = byId.get(id);
    if (!r) return [];
    const a = r.a;
    // The same per-row facts view.ts's factsOf builds: LA status is a Look Ahead field, shown only
    // where that fieldset is (spec §6); ShowHqCommentsField makes the answer depend on edit rights.
    const facts: VisibilityFacts = {
      contactMinistryKey: a.contactMinistryKey, sharedMinistryKeys: sharedKeys.get(id) ?? [], isConfidential: a.isConfidential, isDeleted: a.deletedAt !== null,
    };
    const seesLookAhead = can.seeLookAheadFieldset(actor, rules, facts);
    const row: ListRow = {
      id: a.id, version: a.version, ministryKey: a.contactMinistryKey, ministryAbbreviation: r.ministryAbbreviation,
      status: a.status, hqStatus: seesLookAhead ? a.hqStatus : null, isDeleted: a.deletedAt !== null,
      isWatched: mine.has(id), watcherNames: watchers.get(id) ?? [], isShared: shared.has(id), hasRelease: released.has(id),
      createdAt: a.createdAt.toISOString(), lastUpdatedAt: a.lastUpdatedAt.toISOString(), lastUpdatedByName: r.updaterName,
      keywords: kws.get(id) ?? [], startAt: iso(a.startAt), endAt: iso(a.endAt), isAllDay: a.isAllDay, isConfirmed: a.isConfirmed, potentialDates: a.potentialDates ?? "",
      title: a.title, details: a.details, significance: a.significance, strategy: a.strategy ?? "", schedule: a.schedule,
      categories: cats.get(id) ?? [], isIssue: a.isIssue, isConfidential: a.isConfidential,
      commMaterials: materials.get(id) ?? [], nrOrigins: origins.get(id) ?? [], nrDistribution: r.distribution,
      premierRequested: r.premier, leadOrganization: a.leadOrganization ?? "", translations: a.translations,
      // Legacy's CityOrOther: the Other City text when the city is "Other…".
      city: a.cityId === rules.otherCityId ? a.otherCity : r.cityName, venue: a.venue ?? "",
      commContact: a.commContactId === null ? null : { name: r.contactName ?? "Unknown", phone: r.contactPhone },
      governmentRepresentative: r.representative, eventPlanner: r.eventPlanner,
      needsReview: markup ? a.needsReview : [],
    };
    return [{ row, activity: a, seesLookAhead }];
  });
}
