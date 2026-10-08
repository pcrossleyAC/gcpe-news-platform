import { inArray } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import type { CalendarRules } from "@gcpe/calendar-contract";
import { enqueueEvent, type ActivityEvent, type SubscriberConfig } from "@gcpe/events";
import { categories, cities } from "../db/schema";
import { loadStored } from "./store";

const aggregateId = (id: number) => `activity:${id}`;

/** The §5.4 payload. A confidential activity leaves as its id only: no text leaves the Calendar (C127). */
export async function activityEventData(db: DbOrTx, id: number, rules: CalendarRules): Promise<ActivityEvent> {
  const s = (await loadStored(db, id))!;
  const r = s.row;
  const isDeleted = r.deletedAt !== null;
  if (r.isConfidential) return { id, isConfidential: true, isDeleted };
  const categoryNames = s.joins.categoryIds.length ? (await db.select({ name: categories.name }).from(categories).where(inArray(categories.id, s.joins.categoryIds))).map((c) => c.name) : [];
  const cityName = r.cityId === null ? null : r.cityId === rules.otherCityId ? (r.otherCity || null) : ((await db.select({ name: cities.name }).from(cities).where(inArray(cities.id, [r.cityId])))[0]?.name ?? null);
  return {
    id, isConfidential: false, isDeleted, title: r.title, details: r.details,
    startAt: r.startAt?.toISOString() ?? null, endAt: r.endAt?.toISOString() ?? null, nrAt: r.nrAt?.toISOString() ?? null,
    isAllDay: r.isAllDay, isConfirmed: r.isConfirmed, contactMinistryKey: r.contactMinistryKey, sharedMinistryKeys: s.joins.sharedWithKeys,
    categoryNames, cityName, themeKeys: s.joins.themeKeys, tagKeys: s.joins.tagKeys, sectorKeys: s.joins.sectorKeys, translations: r.translations,
  };
}

/** In the write's own transaction (spec addendum §7.1 "Events"). */
export async function emitActivity(tx: Tx, deps: { rules: CalendarRules; subscribers: SubscriberConfig[] }, id: number, type: "activity.created" | "activity.updated"): Promise<void> {
  await enqueueEvent(tx, { type, source: "calendar", aggregateId: aggregateId(id), data: await activityEventData(tx, id, deps.rules) }, deps.subscribers);
}

export async function emitActivityDeleted(tx: Tx, deps: { subscribers: SubscriberConfig[] }, id: number): Promise<void> {
  await enqueueEvent(tx, { type: "activity.deleted", source: "calendar", aggregateId: aggregateId(id), data: { id } }, deps.subscribers);
}
