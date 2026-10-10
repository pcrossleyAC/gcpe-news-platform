import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { sqlInterval, sqlNow, type Db, type DbOrTx, type TestClock, type Tx } from "@gcpe/db-kit";
import { cleanDetails, cleanTitle, LOCK_IDLE_MS, type ActivityFields, type CalendarRules, type HqSection, type HqStatus, type LookAheadInput } from "@gcpe/calendar-contract";
import {
  activities, activityCategories, activityCommMaterials, activityInitiatives, activityKeywords, activityLocks, activityNrOrigins,
  activitySectors, activitySharedWith, activityTags, activityThemes, categories, keywords, orgs, users,
} from "../db/schema";
import { instantOf, wallClock } from "../time";
import { visibleSql, type Viewer, type VisibilityFacts } from "../visibility";
import type { ReviewSnapshot } from "./review-rules";

export type ActivityRow = typeof activities.$inferSelect;
export interface JoinIds {
  categoryIds: number[];
  commMaterialIds: number[];
  initiativeIds: number[];
  keywordIds: number[];
  nrOriginIds: number[];
  sectorKeys: string[];
  themeKeys: string[];
  tagKeys: string[];
  sharedWithKeys: string[];
}
export interface StoredActivity {
  row: ActivityRow;
  joins: JoinIds;
  keywordNames: string[];
}
/** The content a save writes: everything but status, flags, the Look Ahead fields and bookkeeping. */
export interface Content {
  startAt: Date | null;
  endAt: Date | null;
  nrAt: Date | null;
  potentialDates: string;
  isAllDay: boolean;
  isConfirmed: boolean;
  title: string;
  details: string;
  schedule: string;
  significance: string;
  strategy: string;
  comments: string;
  leadOrganization: string;
  venue: string;
  otherCity: string;
  translations: string[];
  nrDistributionId: number | null;
  premierRequestedId: number | null;
  contactMinistryKey: string | null;
  governmentRepresentativeId: number | null;
  commContactId: number | null;
  eventPlannerId: number | null;
  videographerId: number | null;
  cityId: number | null;
  isIssue: boolean;
  isAtLegislature: boolean;
  isConfidential: boolean;
  isCrossGovernment: boolean;
  isMilestone: boolean;
}
export interface LookAheadValues {
  hqComments: string;
  hqStatus: HqStatus | null;
  hqSection: HqSection;
  longTermOutlook: boolean;
}

export const uniqNum = (xs: readonly number[]) => [...new Set(xs)].sort((a, b) => a - b);
export const uniqStr = (xs: readonly string[]) => [...new Set(xs)].sort();

/**
 * Runs a reader's queries in one REPEATABLE READ, READ ONLY transaction, so the row, its join sets
 * and its history are one snapshot even while a write commits between them.
 */
export function inReadSnapshot<T>(db: Db, read: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Every write to one activity takes this first, then reads the row FOR UPDATE and re-checks it. */
export async function lockActivity(tx: Tx, id: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-activity:${id}`}))`);
}

/**
 * The activity with its join sets, or null when there is none. With `visibleTo`, an activity that
 * viewer may not see is null too: the row is filtered by visibleSql, so a reader never holds an
 * invisible row (spec addendum §6).
 */
export async function loadStored(db: DbOrTx, id: number, opts: { forUpdate?: boolean; visibleTo?: Viewer } = {}): Promise<StoredActivity | null> {
  const q = db.select().from(activities).where(opts.visibleTo ? and(eq(activities.id, id), visibleSql(opts.visibleTo)) : eq(activities.id, id));
  const [row] = opts.forUpdate ? await q.for("update") : await q;
  if (!row) return null;
  const nums = (rows: { v: number }[]) => uniqNum(rows.map((r) => r.v));
  const strs = (rows: { v: string }[]) => uniqStr(rows.map((r) => r.v));
  const kw = await db.select({ id: keywords.id, name: keywords.name }).from(activityKeywords).innerJoin(keywords, eq(keywords.id, activityKeywords.keywordId)).where(eq(activityKeywords.activityId, id)).orderBy(asc(keywords.name));
  return {
    row,
    keywordNames: kw.map((k) => k.name),
    joins: {
      categoryIds: nums(await db.select({ v: activityCategories.categoryId }).from(activityCategories).where(eq(activityCategories.activityId, id))),
      commMaterialIds: nums(await db.select({ v: activityCommMaterials.commMaterialId }).from(activityCommMaterials).where(eq(activityCommMaterials.activityId, id))),
      initiativeIds: nums(await db.select({ v: activityInitiatives.initiativeId }).from(activityInitiatives).where(eq(activityInitiatives.activityId, id))),
      keywordIds: uniqNum(kw.map((k) => k.id)),
      nrOriginIds: nums(await db.select({ v: activityNrOrigins.nrOriginId }).from(activityNrOrigins).where(eq(activityNrOrigins.activityId, id))),
      sectorKeys: strs(await db.select({ v: activitySectors.termKey }).from(activitySectors).where(eq(activitySectors.activityId, id))),
      themeKeys: strs(await db.select({ v: activityThemes.termKey }).from(activityThemes).where(eq(activityThemes.activityId, id))),
      tagKeys: strs(await db.select({ v: activityTags.termKey }).from(activityTags).where(eq(activityTags.activityId, id))),
      sharedWithKeys: strs(await db.select({ v: activitySharedWith.ministryKey }).from(activitySharedWith).where(eq(activitySharedWith.activityId, id))),
    },
  };
}

export function factsOf(s: StoredActivity): VisibilityFacts {
  return { contactMinistryKey: s.row.contactMinistryKey, sharedMinistryKeys: s.joins.sharedWithKeys, isConfidential: s.row.isConfidential, isDeleted: s.row.deletedAt !== null };
}

export function contentOf(r: ActivityRow): Content {
  return {
    startAt: r.startAt, endAt: r.endAt, nrAt: r.nrAt, potentialDates: r.potentialDates ?? "", isAllDay: r.isAllDay, isConfirmed: r.isConfirmed,
    title: r.title, details: r.details, schedule: r.schedule, significance: r.significance, strategy: r.strategy ?? "", comments: r.comments ?? "",
    leadOrganization: r.leadOrganization ?? "", venue: r.venue ?? "", otherCity: r.otherCity ?? "", translations: r.translations,
    nrDistributionId: r.nrDistributionId, premierRequestedId: r.premierRequestedId, contactMinistryKey: r.contactMinistryKey,
    governmentRepresentativeId: r.governmentRepresentativeId, commContactId: r.commContactId, eventPlannerId: r.eventPlannerId,
    videographerId: r.videographerId, cityId: r.cityId, isIssue: r.isIssue, isAtLegislature: r.isAtLegislature, isConfidential: r.isConfidential,
    isCrossGovernment: r.isCrossGovernment, isMilestone: r.isMilestone,
  };
}

export function lookAheadOf(r: ActivityRow): LookAheadValues {
  return { hqComments: r.hqComments ?? "", hqStatus: r.hqStatus, hqSection: r.hqSection, longTermOutlook: r.longTermOutlook };
}

/** The stored activity as the editor's fields, in BC wall-clock time. An all-day activity has no times. */
export function fieldsOf(s: StoredActivity, timeZone: string): ActivityFields {
  const r = s.row;
  const local = (d: Date | null) => (d ? wallClock(d, timeZone) : null);
  const [start, end, nr] = [local(r.startAt), local(r.endAt), local(r.nrAt)];
  const c = contentOf(r);
  return {
    categoryId: s.joins.categoryIds[0] ?? null,
    title: c.title, details: c.details, significance: c.significance, strategy: c.strategy, schedule: c.schedule, comments: c.comments,
    leadOrganization: c.leadOrganization, venue: c.venue, otherCity: c.otherCity, potentialDates: c.potentialDates,
    isIssue: c.isIssue, isConfidential: c.isConfidential, isMilestone: c.isMilestone, isCrossGovernment: c.isCrossGovernment,
    isAtLegislature: c.isAtLegislature, isAllDay: c.isAllDay, isConfirmed: c.isConfirmed,
    startDate: start?.date ?? null, startTime: c.isAllDay ? null : (start?.time ?? null),
    endDate: end?.date ?? null, endTime: c.isAllDay ? null : (end?.time ?? null),
    nrDate: nr?.date ?? null, nrTime: nr?.time ?? null,
    contactMinistryKey: c.contactMinistryKey, commContactId: c.commContactId, governmentRepresentativeId: c.governmentRepresentativeId,
    cityId: c.cityId, premierRequestedId: c.premierRequestedId, nrDistributionId: c.nrDistributionId, eventPlannerId: c.eventPlannerId,
    videographerId: c.videographerId, nrOriginId: s.joins.nrOriginIds[0] ?? null,
    commMaterialIds: s.joins.commMaterialIds, initiativeIds: s.joins.initiativeIds, keywordNames: s.keywordNames,
    sectorKeys: s.joins.sectorKeys, themeKeys: s.joins.themeKeys, tagKeys: s.joins.tagKeys, sharedWithKeys: s.joins.sharedWithKeys,
    translations: c.translations,
    lookAhead: lookAheadOf(r),
  };
}

/** The editor's fields as columns. All-day starts at 00:00 and ends at 23:45 BC, as legacy's GetDateTime (Activity.aspx.cs:921-938). */
export function contentFrom(i: ActivityFields, rules: CalendarRules): Content {
  const tz = rules.timeZone;
  return {
    startAt: i.startDate ? instantOf(i.startDate, i.isAllDay || !i.startTime ? "00:00" : i.startTime, tz) : null,
    endAt: i.endDate ? instantOf(i.endDate, i.isAllDay || !i.endTime ? "23:45" : i.endTime, tz) : null,
    nrAt: i.nrDate && i.nrTime ? instantOf(i.nrDate, i.nrTime, tz) : null,
    potentialDates: i.potentialDates.trim(),
    isAllDay: i.isAllDay,
    isConfirmed: i.isConfirmed,
    title: cleanTitle(i.title),
    details: cleanDetails(i.details),
    schedule: i.schedule.trim(),
    significance: i.significance.trim(),
    strategy: i.strategy.trim(),
    comments: i.comments.trim(),
    leadOrganization: i.leadOrganization.trim(),
    venue: i.venue.trim(),
    // Legacy clears Other City unless the city is "Other…" (Activity.aspx.cs:1213-1214).
    otherCity: i.cityId === rules.otherCityId ? i.otherCity.trim() : "",
    translations: uniqStr(i.translations.map((t) => t.trim()).filter(Boolean)),
    nrDistributionId: i.nrDistributionId,
    premierRequestedId: i.premierRequestedId,
    contactMinistryKey: i.contactMinistryKey,
    governmentRepresentativeId: i.governmentRepresentativeId,
    commContactId: i.commContactId,
    eventPlannerId: i.eventPlannerId,
    videographerId: i.videographerId,
    cityId: i.cityId,
    isIssue: i.isIssue,
    isAtLegislature: i.isAtLegislature,
    isConfidential: i.isConfidential,
    isCrossGovernment: i.isCrossGovernment,
    isMilestone: i.isMilestone,
  };
}

/** Empty optional text is stored null, as imported legacy rows hold it. */
export function columnsOf(c: Content) {
  return { ...c, strategy: c.strategy || null, comments: c.comments || null, leadOrganization: c.leadOrganization || null, venue: c.venue || null, otherCity: c.otherCity || null, potentialDates: c.potentialDates || null };
}

/**
 * The values the needs-review rules compare. Title and Summary go through the save's clean-up on both
 * sides, so an imported value the clean-up only rewrites (a curly quote, an ellipsis) isn't a change.
 */
export function snapshotOf(c: Content, j: JoinIds): ReviewSnapshot {
  return {
    title: cleanTitle(c.title), details: cleanDetails(c.details), governmentRepresentativeId: c.governmentRepresentativeId, cityId: c.cityId, otherCity: c.otherCity,
    startAt: c.startAt?.getTime() ?? null, endAt: c.endAt?.getTime() ?? null, potentialDates: c.potentialDates,
    categoryIds: j.categoryIds, isIssue: c.isIssue, isConfidential: c.isConfidential, commMaterialIds: j.commMaterialIds,
    significance: c.significance, comments: c.comments, schedule: c.schedule, strategy: c.strategy, leadOrganization: c.leadOrganization,
    venue: c.venue, initiativeIds: j.initiativeIds, keywordIds: j.keywordIds, nrOriginIds: j.nrOriginIds, translations: c.translations,
    premierRequestedId: c.premierRequestedId, nrDistributionId: c.nrDistributionId, eventPlannerId: c.eventPlannerId,
    videographerId: c.videographerId, isConfirmed: c.isConfirmed, isAllDay: c.isAllDay, isCrossGovernment: c.isCrossGovernment,
  };
}

export async function insertActivity(tx: Tx, v: { content: Content; lookAhead: LookAheadValues; actorId: string; at: Date }): Promise<number> {
  const [row] = await tx
    .insert(activities)
    .values({
      ...columnsOf(v.content),
      hqComments: v.lookAhead.hqComments || null, hqStatus: v.lookAhead.hqStatus, hqSection: v.lookAhead.hqSection, longTermOutlook: v.lookAhead.longTermOutlook,
      status: "new", needsReview: [], createdAt: v.at, createdBy: v.actorId, lastUpdatedAt: v.at, lastUpdatedBy: v.actorId, version: 1,
    })
    .returning({ id: activities.id });
  return row!.id;
}

/** Replaces every join row: saving replaces each whole set, as legacy's UpdateLinkingTables did. */
export async function replaceJoins(tx: Tx, id: number, j: JoinIds): Promise<void> {
  await tx.delete(activityCategories).where(eq(activityCategories.activityId, id));
  await tx.delete(activityCommMaterials).where(eq(activityCommMaterials.activityId, id));
  await tx.delete(activityInitiatives).where(eq(activityInitiatives.activityId, id));
  await tx.delete(activityKeywords).where(eq(activityKeywords.activityId, id));
  await tx.delete(activityNrOrigins).where(eq(activityNrOrigins.activityId, id));
  await tx.delete(activitySectors).where(eq(activitySectors.activityId, id));
  await tx.delete(activityThemes).where(eq(activityThemes.activityId, id));
  await tx.delete(activityTags).where(eq(activityTags.activityId, id));
  await tx.delete(activitySharedWith).where(eq(activitySharedWith.activityId, id));
  const cats = uniqNum(j.categoryIds);
  if (cats.length) await tx.insert(activityCategories).values(cats.map((categoryId) => ({ activityId: id, categoryId })));
  const materials = uniqNum(j.commMaterialIds);
  if (materials.length) await tx.insert(activityCommMaterials).values(materials.map((commMaterialId) => ({ activityId: id, commMaterialId })));
  const inits = uniqNum(j.initiativeIds);
  if (inits.length) await tx.insert(activityInitiatives).values(inits.map((initiativeId) => ({ activityId: id, initiativeId })));
  const kws = uniqNum(j.keywordIds);
  if (kws.length) await tx.insert(activityKeywords).values(kws.map((keywordId) => ({ activityId: id, keywordId })));
  const origins = uniqNum(j.nrOriginIds);
  if (origins.length) await tx.insert(activityNrOrigins).values(origins.map((nrOriginId) => ({ activityId: id, nrOriginId })));
  const sectors = uniqStr(j.sectorKeys);
  if (sectors.length) await tx.insert(activitySectors).values(sectors.map((termKey) => ({ activityId: id, termKey })));
  const themes = uniqStr(j.themeKeys);
  if (themes.length) await tx.insert(activityThemes).values(themes.map((termKey) => ({ activityId: id, termKey })));
  const tags = uniqStr(j.tagKeys);
  if (tags.length) await tx.insert(activityTags).values(tags.map((termKey) => ({ activityId: id, termKey })));
  const shared = uniqStr(j.sharedWithKeys);
  if (shared.length) await tx.insert(activitySharedWith).values(shared.map((ministryKey) => ({ activityId: id, ministryKey })));
}

/** The keywords' stored names, in name order: a reused keyword keeps its own spelling. */
export async function keywordNamesOf(db: DbOrTx, ids: readonly number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return (await db.select({ name: keywords.name }).from(keywords).where(inArray(keywords.id, [...ids])).orderBy(asc(keywords.name))).map((k) => k.name);
}

/** The inference's inputs for some fields: category names and the ministry's abbreviation come from the database. */
export async function lookAheadInputOf(db: DbOrTx, f: ActivityFields, categoryIds: number[], currentSection: HqSection | null): Promise<LookAheadInput> {
  const names = categoryIds.length ? (await db.select({ name: categories.name }).from(categories).where(inArray(categories.id, categoryIds))).map((c) => c.name) : [];
  const [org] = f.contactMinistryKey ? await db.select({ abbreviation: orgs.abbreviation }).from(orgs).where(eq(orgs.key, f.contactMinistryKey)) : [];
  return {
    categoryIds, categoryNames: names, contactMinistryAbbreviation: org?.abbreviation ?? null, isConfidential: f.isConfidential,
    isIssue: f.isIssue, isConfirmed: f.isConfirmed, commMaterialIds: f.commMaterialIds, startDate: f.startDate, endDate: f.endDate, currentSection,
  };
}

/** A lock whose last activity is at or before this instant has lapsed. */
export function lockIdleCutoff(clock?: TestClock) {
  return sql`(${sqlNow(clock)} - ${sqlInterval(LOCK_IDLE_MS)})`;
}

export interface LiveLock {
  userId: string;
  tabId: string;
  acquiredAt: Date;
  holderName: string;
}

export async function liveLockOf(db: DbOrTx, activityId: number, clock?: TestClock, opts: { forUpdate?: boolean } = {}): Promise<LiveLock | null> {
  const q = db
    .select({ userId: activityLocks.userId, tabId: activityLocks.tabId, acquiredAt: activityLocks.acquiredAt, lastActiveAt: activityLocks.lastActiveAt, live: sql<boolean>`${activityLocks.lastActiveAt} > ${lockIdleCutoff(clock)}` })
    .from(activityLocks)
    .where(eq(activityLocks.activityId, activityId));
  const [lock] = opts.forUpdate ? await q.for("update") : await q;
  if (!lock || !lock.live) return null;
  const [holder] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, lock.userId));
  return { userId: lock.userId, tabId: lock.tabId, acquiredAt: lock.acquiredAt, holderName: holder?.name ?? "Someone" };
}
