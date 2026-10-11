import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ActivityEvent, EventEnvelope, EventHandler, UserRecord } from "@gcpe/events";
import { calendarActivities, calendarViewers } from "../db/schema";

// Ordering and redelivery are the receiver's job (packages/events/src/receiver.ts): it applies an
// event only when its sequence is past the activity's or user's last one, and acknowledges a
// duplicate without applying it. Each event carries the whole current state, so a handler simply
// replaces the row. The Calendar has no undelete: an activity it deleted arrives as deleted from
// then on (activity.deleted, then activity.updated with isDeleted when it is reviewed).

type ActivityRow = typeof calendarActivities.$inferInsert;

/** Every content column empty: what a confidential activity, or a deletion never seen live, keeps (C127). */
function idOnly(id: number, isDeleted: boolean): ActivityRow {
  return {
    id, isConfidential: true, isDeleted, title: null, details: null, startAt: null, endAt: null, nrAt: null, isAllDay: null, isConfirmed: null,
    contactMinistryKey: null, sharedMinistryKeys: [], categoryNames: [], cityName: null, themeKeys: [], tagKeys: [], sectorKeys: [], translations: [],
  };
}

const at = (iso: string | null) => (iso === null ? null : new Date(iso));

function rowOf(a: ActivityEvent): ActivityRow {
  if (a.isConfidential) return idOnly(a.id, a.isDeleted);
  return {
    id: a.id, isConfidential: false, isDeleted: a.isDeleted, title: a.title, details: a.details,
    startAt: at(a.startAt), endAt: at(a.endAt), nrAt: at(a.nrAt), isAllDay: a.isAllDay, isConfirmed: a.isConfirmed,
    contactMinistryKey: a.contactMinistryKey, sharedMinistryKeys: a.sharedMinistryKeys, categoryNames: a.categoryNames, cityName: a.cityName,
    themeKeys: a.themeKeys, tagKeys: a.tagKeys, sectorKeys: a.sectorKeys, translations: a.translations,
  };
}

const onActivity: EventHandler = async (tx, e) => {
  const row = rowOf(e.data as ActivityEvent);
  await tx.insert(calendarActivities).values(row).onConflictDoUpdate({ target: calendarActivities.id, set: row });
};

/** Marks it deleted and keeps whatever else the row holds; an activity never seen becomes an id-only deleted row. */
const onActivityDeleted: EventHandler = async (tx, e) => {
  const { id } = e.data as { id: number };
  await tx.insert(calendarActivities).values(idOnly(id, true)).onConflictDoUpdate({ target: calendarActivities.id, set: { isDeleted: true } });
};

/** Core's user.upserted: the Calendar role, ministries and active state. The email and name are dropped. */
const onUser: EventHandler = async (tx, e) => {
  const u = e.data as UserRecord;
  const row = { userId: u.id.toLowerCase(), isActive: u.isActive, calendarRole: u.calendarRole, organizationKeys: [...new Set(u.organizationKeys)].sort() };
  await tx.insert(calendarViewers).values(row).onConflictDoUpdate({ target: calendarViewers.userId, set: row });
};

/** The Calendar's activity.* (from the Calendar only) and Core's user.upserted (from Core only). */
export function calendarHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source === "calendar") {
    if (event.type === "activity.created" || event.type === "activity.updated") return onActivity;
    if (event.type === "activity.deleted") return onActivityDeleted;
    return undefined;
  }
  if (event.source === "core" && event.type === "user.upserted") return onUser;
  return undefined;
}

/** True until Core's users have reached NRMS; the stack then asks Core to republish. */
export async function needsCalendarViewers(db: DbOrTx): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${calendarViewers}`);
  return r.rows[0]!.n === 0;
}
