import { and, eq, inArray, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import {
  ACTIVITY_STATUSES, LEVEL, LIST_PAGE_SIZE, type CalendarRules, type CorporateQuery, type HqStatus, type ListDisplay, type ListFilter, type ListQuery, type ListSort,
} from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { ActivityForbiddenError } from "../activities/errors";
import { inReadSnapshot } from "../activities/store";
import { can } from "../capabilities";
import {
  activities, activityCategories, activityCommMaterials, activityInitiatives, activityKeywords, activitySharedWith,
  categories, cities, commContacts, commMaterials, favourites, governmentRepresentatives, keywords, orgs, users,
} from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { addDays, bcMidnight, dbNow, wallClock } from "../time";
import { visibleSql } from "../visibility";

/** What every list reader needs besides the query. */
export interface ListScope {
  actor: CalendarActor;
  rules: CalendarRules;
  /** Today's BC date (YYYY-MM-DD) by the database's clock. */
  today: string;
  /** Keys of the organizations carrying the tenant's consultations abbreviation. */
  consultationsKeys: string[];
}

/** Today's BC date (YYYY-MM-DD) by the database's clock. */
export async function todayOf(db: DbOrTx, deps: ApiDeps): Promise<string> {
  return wallClock(await dbNow(db, deps.now), deps.rules.timeZone).date;
}

export async function scopeOf(db: DbOrTx, deps: ApiDeps, actor: CalendarActor): Promise<ListScope> {
  const today = await todayOf(db, deps);
  const consult = await db.select({ key: orgs.key }).from(orgs).where(eq(orgs.abbreviation, deps.rules.consultationsMinistryAbbreviation));
  return { actor, rules: deps.rules, today, consultationsKeys: consult.map((o) => o.key) };
}

/** Legacy clamps earlier dates (ActivityDAO.cs:172-173). */
const EARLIEST = "2011-01-01";
/** Legacy searched by id only above this; a smaller number is a word, such as a year (ActivityDAO.cs:68-76). */
export const ID_SEARCH_FLOOR = 10_000;
const INT4_MAX = 2_147_483_647;

/** The activity a quick search names: a bare number above 10,000, or the list's "ABBR-123" at any size. */
export function idSearchOf(term: string): number | null {
  const m = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d{1,10})$/.exec(term.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (n < 1 || n > INT4_MAX) return null;
  return m[1] !== undefined || n > ID_SEARCH_FLOOR ? n : null;
}

/** A LIKE pattern that matches `term` literally: backslash is Postgres's default LIKE escape. */
export const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const contains = (value: SQLWrapper, pattern: string) => sql`coalesce(${value}, '') ILIKE ${pattern}`;
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * Legacy's eleven fields (ActivityDAO.cs:101-117), plus Other City, which legacy didn't search (C178). The
 * Executive Summary is one of the eleven, matched only where the actor sees it (C172).
 */
function textSearch(scope: ListScope, term: string): SQL {
  const p = containsPattern(term);
  const fields: SQL[] = [
    contains(activities.title, p),
    contains(activities.details, p),
    sql`EXISTS (SELECT 1 FROM ${cities} WHERE ${cities.id} = ${activities.cityId} AND ${cities.name} ILIKE ${p})`,
    contains(activities.otherCity, p),
    contains(sql`array_to_string(${activities.translations}, ', ')`, p),
    contains(activities.significance, p),
    contains(activities.comments, p),
    contains(activities.leadOrganization, p),
    contains(activities.strategy, p),
    contains(activities.schedule, p),
    contains(activities.venue, p),
  ];
  const summary = executiveSummaryShown(scope);
  if (summary) fields.push(sql`(${summary} AND ${contains(activities.hqComments, p)})`);
  return sql`(${sql.join(fields, sql` OR `)})`;
}

/**
 * The rows whose Executive Summary the actor sees, so a search hit never reveals it (C172): a Look
 * Ahead field, shown where `can.seeLookAheadFieldset(actor, rules, activity)` holds, which the
 * caller's `visibleSql` already narrows to visible rows. Null when there are none.
 */
export function executiveSummaryShown(scope: ListScope): SQL | null {
  const { actor, rules } = scope;
  // An HQ Editor or above sees the fieldset on every row.
  if (actor.isHq && actor.level >= LEVEL.editor) return sql`true`;
  // Anyone else only where the tenant's ShowHqCommentsField is on and they may edit the row. That is
  // can.edit: Editor or above, not deleted, and their own contact ministry (shared-with doesn't count).
  if (!rules.showHqCommentsField || actor.level < LEVEL.editor || actor.ministryKeys.length === 0) return null;
  return sql`(${activities.deletedAt} IS NULL AND ${inArray(activities.contactMinistryKey, [...actor.ministryKeys])})`;
}

/** A deleted activity waiting for HQ to review its deletion. Only HQ Administrators can see one at all. */
const awaitingReview = sql`(${activities.deletedAt} IS NOT NULL AND 'active' = ANY(${activities.needsReview}))`;

/** ActivityDAO.cs:176-193: deletions awaiting review show with no status chosen and under Changed. */
function statusWhere(status: ListFilter["status"]): SQL {
  if (status === null) return sql`(${activities.deletedAt} IS NULL OR ${awaitingReview})`;
  if (status === "changed") return sql`((${activities.deletedAt} IS NULL AND ${activities.status} = 'changed') OR ${awaitingReview})`;
  return sql`(${activities.deletedAt} IS NULL AND ${activities.status} = ${status})`;
}

const sharedWith = (key: string) =>
  sql`EXISTS (SELECT 1 FROM ${activitySharedWith} WHERE ${activitySharedWith.activityId} = ${activities.id} AND ${activitySharedWith.ministryKey} = ${key})`;

/** The default list hides Awareness dates and the consultations ministry unless the filter names them (ActivityListProvider.ashx.cs:90-91). */
function defaultHides(scope: ListScope, f: ListFilter): SQL[] {
  const out: SQL[] = [];
  const awareness = [...scope.rules.awarenessCategoryIds];
  if (f.categoryId === null && awareness.length) {
    out.push(sql`NOT EXISTS (SELECT 1 FROM ${activityCategories} WHERE ${activityCategories.activityId} = ${activities.id} AND ${inArray(activityCategories.categoryId, awareness)})`);
  }
  const consult = scope.consultationsKeys;
  const onlyConsultations = scope.actor.ministryKeys.length === 1 && consult.includes(scope.actor.ministryKeys[0]!);
  if (f.ministryKey === null && consult.length && !onlyConsultations) {
    out.push(sql`(${activities.contactMinistryKey} IS NULL OR ${notInArray(activities.contactMinistryKey, consult)})`);
  }
  return out;
}

/** The filter panel and the display (spec addendum §8.1; ActivityDAO.cs:150-258). */
export function filterWhere(scope: ListScope, f: ListFilter, display: ListDisplay): SQL {
  const { actor, rules } = scope;
  const tz = rules.timeZone;
  const parts: SQL[] = [statusWhere(f.status)];
  if (f.quickSearch) parts.push(textSearch(scope, f.quickSearch));
  const from = later(f.from ?? scope.today, EARLIEST);
  if (f.thisDayOnly) {
    parts.push(sql`${activities.startAt} >= ${bcMidnight(from, tz)}`, sql`${activities.endAt} < ${bcMidnight(addDays(from, 1), tz)}`);
  } else {
    // Overlapping the range: ending on or after From, starting before the day after To (ActivityDAO.cs:243).
    parts.push(sql`coalesce(${activities.endAt}, ${activities.startAt}) >= ${bcMidnight(from, tz)}`);
    if (f.to) parts.push(sql`coalesce(${activities.startAt}, ${activities.endAt}) < ${bcMidnight(addDays(f.to, 1), tz)}`);
  }
  if (f.keywordIds.length) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${activityKeywords} WHERE ${activityKeywords.activityId} = ${activities.id} AND ${inArray(activityKeywords.keywordId, f.keywordIds)})`);
  }
  if (f.isIssue !== null) parts.push(eq(activities.isIssue, f.isIssue));
  if (f.dateConfirmed !== null) {
    // Legacy always counts a timed single-day activity as matching (ActivityDAO.cs:198).
    parts.push(sql`(${activities.isConfirmed} = ${f.dateConfirmed} OR (NOT ${activities.isAllDay} AND (${activities.startAt} AT TIME ZONE ${tz})::date = (${activities.endAt} AT TIME ZONE ${tz})::date))`);
  }
  if (f.categoryId !== null) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${activityCategories} WHERE ${activityCategories.activityId} = ${activities.id} AND ${activityCategories.categoryId} = ${f.categoryId})`);
  }
  if (f.initiativeId !== null) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${activityInitiatives} WHERE ${activityInitiatives.activityId} = ${activities.id} AND ${activityInitiatives.initiativeId} = ${f.initiativeId})`);
  }
  if (f.representativeId !== null) parts.push(eq(activities.governmentRepresentativeId, f.representativeId));
  if (f.premierRequestedId !== null) parts.push(eq(activities.premierRequestedId, f.premierRequestedId));
  if (f.distributionId !== null) parts.push(eq(activities.nrDistributionId, f.distributionId));
  if (display === "my_ministries") {
    // Their own ministries' activities, not those only shared with them (ActivityDAO.cs:216-236).
    const keys = f.ministryKey !== null ? [f.ministryKey] : actor.ministryKeys;
    parts.push(keys.length ? inArray(activities.contactMinistryKey, keys) : sql`false`);
  } else if (f.ministryKey !== null) {
    parts.push(sql`(${activities.contactMinistryKey} = ${f.ministryKey} OR ${sharedWith(f.ministryKey)})`);
  }
  // A person, whichever of their comm contact rows the activity holds, inactive ones included.
  const person = display === "my_activities" ? (f.commContactUserId ?? actor.userId) : f.commContactUserId;
  if (person !== null) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${commContacts} WHERE ${commContacts.id} = ${activities.commContactId} AND ${commContacts.userId} = ${person})`);
  }
  if (display === "my_watchlist") {
    parts.push(sql`EXISTS (SELECT 1 FROM ${favourites} WHERE ${favourites.activityId} = ${activities.id} AND ${favourites.userId} = ${actor.userId})`);
  } else {
    parts.push(...defaultHides(scope, f));
  }
  return and(...parts)!;
}

/** Corporate Queries (ActivityDAO.cs:306-368): upcoming activities by status and LA status. */
export function corporateWhere(scope: ListScope, c: CorporateQuery): SQL {
  const tz = scope.rules.timeZone;
  const parts: SQL[] = [sql`${activities.endAt} > ${bcMidnight(scope.today, tz)}`];
  if (c.days !== null) parts.push(sql`${activities.startAt} <= ${bcMidnight(addDays(scope.today, c.days + 1), tz)}`);
  const s = new Set(c.statuses);
  const live = ACTIVITY_STATUSES.filter((x) => s.has(x));
  const la: HqStatus[] = [];
  if (s.has("la_new")) la.push("new");
  if (s.has("la_changed")) la.push("changed");
  const any: SQL[] = [];
  if (live.length) any.push(sql`(${activities.deletedAt} IS NULL AND ${inArray(activities.status, live)})`);
  if (la.length) any.push(inArray(activities.hqStatus, la));
  // "Changed" brings deletions awaiting review; "Deleted" brings every deletion.
  if (s.has("changed")) any.push(awaitingReview);
  if (s.has("deleted")) any.push(sql`${activities.deletedAt} IS NOT NULL`);
  parts.push(sql`(${sql.join(any, sql` OR `)})`);
  return and(...parts)!;
}

function lookAheadWhere(f: ListQuery["lookAhead"]): SQL | undefined {
  if (f === "look_ahead_only") return sql`NOT ${activities.isConfidential}`;
  if (f === "not_for_look_ahead_only") return sql`${activities.isConfidential}`;
  return undefined;
}

/** The whole predicate: always inside visibleSql, over the unaliased activities table. */
export function listWhere(scope: ListScope, q: ListQuery): SQL {
  if (q.corporate && !can.corporateQueries(scope.actor)) throw new ActivityForbiddenError("Corporate queries are for HQ Advanced users and above");
  if (q.lookAhead !== "all" && !can.lookAheadFilter(scope.actor)) throw new ActivityForbiddenError("The Look Ahead filter is for HQ Advanced users and above");
  const parts: SQL[] = [visibleSql(scope.actor)];
  const id = q.corporate ? null : idSearchOf(q.filter.quickSearch);
  // An id search ignores the other filters and the dates, as legacy (ActivityDAO.cs:68-76).
  if (id !== null) parts.push(eq(activities.id, id));
  else parts.push(q.corporate ? corporateWhere(scope, q.corporate) : filterWhere(scope, q.filter, q.display));
  const la = lookAheadWhere(q.lookAhead);
  if (la) parts.push(la);
  return and(...parts)!;
}

const ministryAbbreviation = sql`(SELECT ${orgs.abbreviation} FROM ${orgs} WHERE ${orgs.key} = ${activities.contactMinistryKey})`;
const categoryNames = sql`(SELECT string_agg(${categories.name}, ', ' ORDER BY ${categories.name}) FROM ${activityCategories} JOIN ${categories} ON ${categories.id} = ${activityCategories.categoryId} WHERE ${activityCategories.activityId} = ${activities.id})`;
const keywordNames = sql`(SELECT string_agg(${keywords.name}, ', ' ORDER BY ${keywords.name}) FROM ${activityKeywords} JOIN ${keywords} ON ${keywords.id} = ${activityKeywords.keywordId} WHERE ${activityKeywords.activityId} = ${activities.id})`;
const commMaterialNames = sql`(SELECT string_agg(${commMaterials.name}, ', ' ORDER BY ${commMaterials.name}) FROM ${activityCommMaterials} JOIN ${commMaterials} ON ${commMaterials.id} = ${activityCommMaterials.commMaterialId} WHERE ${activityCommMaterials.activityId} = ${activities.id})`;
const contactName = sql`(SELECT ${users.displayName} FROM ${commContacts} JOIN ${users} ON ${users.id} = ${commContacts.userId} WHERE ${commContacts.id} = ${activities.commContactId})`;
const representativeName = sql`(SELECT ${governmentRepresentatives.name} FROM ${governmentRepresentatives} WHERE ${governmentRepresentatives.id} = ${activities.governmentRepresentativeId})`;

function sortKeys(sort: ListSort, rules: CalendarRules): SQL[] {
  switch (sort) {
    case "activity":
      return [ministryAbbreviation, sql`${activities.id}`];
    case "keywords":
      return [keywordNames];
    case "ministry":
      return [ministryAbbreviation];
    case "status":
      return [sql`${activities.status}`];
    case "dateTime":
      return [sql`${activities.startAt}`, sql`${activities.endAt}`];
    case "title":
      return [sql`lower(${activities.title})`];
    case "categories":
      return [categoryNames];
    case "commMaterials":
      return [commMaterialNames];
    case "leadOrg":
      return [sql`lower(nullif(${activities.leadOrganization}, ''))`];
    case "translations":
      return [sql`nullif(array_to_string(${activities.translations}, ', '), '')`];
    case "city":
      return [sql`lower(CASE WHEN ${activities.cityId} = ${rules.otherCityId} THEN nullif(${activities.otherCity}, '') ELSE (SELECT ${cities.name} FROM ${cities} WHERE ${cities.id} = ${activities.cityId}) END)`];
    case "commContact":
      return [sql`lower(${contactName})`];
    case "governmentRep":
      return [sql`lower(${representativeName})`];
  }
}

/** The chosen column, then start and id so pages never overlap; empty values last both ways. */
export function listOrder(sort: ListSort, dir: "asc" | "desc", rules: CalendarRules): SQL[] {
  const d = dir === "desc" ? sql`DESC NULLS LAST` : sql`ASC NULLS LAST`;
  return [...sortKeys(sort, rules).map((k) => sql`${k} ${d}`), sql`${activities.startAt} ASC NULLS LAST`, sql`${activities.id} ASC`];
}

/** One page of ids and the total, 30 at a time as legacy's grid. */
export async function listIds(tx: DbOrTx, scope: ListScope, q: ListQuery, offset: number): Promise<{ ids: number[]; total: number }> {
  const where = listWhere(scope, q);
  const rows = await tx
    .select({ id: activities.id, total: sql<number>`count(*) OVER ()`.mapWith(Number) })
    .from(activities)
    .where(where)
    .orderBy(...listOrder(q.sort, q.dir, scope.rules))
    .limit(LIST_PAGE_SIZE)
    .offset(offset);
  if (rows.length) return { ids: rows.map((r) => r.id), total: rows[0]!.total };
  if (offset === 0) return { ids: [], total: 0 };
  // Past the end: no window row to read the total from.
  const [c] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(activities).where(where);
  return { ids: [], total: c!.n };
}

export function listPageIds(deps: ApiDeps, actor: CalendarActor, q: ListQuery, offset: number): Promise<{ ids: number[]; total: number }> {
  return inReadSnapshot(deps.db, async (tx) => listIds(tx, await scopeOf(tx, deps, actor), q, offset));
}
