import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import type { CalendarRules } from "@gcpe/calendar-contract";
import type { OrgSucceeded, SubscriberConfig } from "@gcpe/events";
import { emitActivity } from "./activities/events";
import { writeChange } from "./activities/history";
import { loadStored, lockActivity } from "./activities/store";
import { activities, activitySharedWith, commContacts, orgs } from "./db/schema";
import { bcMidnight, dbNow, wallClock } from "./time";

/** BC's zone name, resolved by this runtime's tzdata (permanent UTC−7 from 2026-11-01). Never an offset. */
export const BC_TIME_ZONE = "America/Vancouver";
/** Succession's history actor: no person made this change. */
export const SYSTEM_ACTOR = { userId: "00000000-0000-0000-0000-000000000000", displayName: "System" };

export interface SuccessionCounts {
  activities: number;
  contacts: number;
}
export type SuccessionDeps = Pick<{ rules: CalendarRules; subscribers: SubscriberConfig[] }, "rules" | "subscribers">;

/**
 * Upcoming, judged in BC time (new-government spec §4, N9): starts at or after `at`, or has no
 * start. An all-day activity starts at BC midnight, so one on the BC day of `at` is today's, and
 * moves too, though its midnight is before `at`.
 */
function upcoming(at: Date, timeZone: string): SQL {
  const dayStart = bcMidnight(wallClock(at, timeZone).date, timeZone);
  return or(
    isNull(activities.startAt),
    sql`${activities.startAt} >= ${at}`,
    and(eq(activities.isAllDay, true), sql`${activities.startAt} >= ${dayStart}`),
  )!;
}
const movable = (key: string, at: Date, timeZone: string) =>
  and(eq(activities.contactMinistryKey, key), isNull(activities.deletedAt), upcoming(at, timeZone))!;
/** Active only: a contact already deactivated is history, and stays where it is. */
const movableContacts = (key: string) => and(eq(commContacts.ministryKey, key), eq(commContacts.isActive, true))!;

/** What applySuccession would move now. Read-only. */
export async function successionCounts(db: DbOrTx, key: string, at: Date, timeZone: string = BC_TIME_ZONE): Promise<SuccessionCounts> {
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(activities).where(movable(key, at, timeZone));
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(commContacts).where(movableContacts(key));
  return { activities: a!.n, contacts: c!.n };
}

/**
 * org.succeeded (new-government spec §4): upcoming and undated activities, and the communication
 * contacts, of the old ministry go to its first successor. Idempotent: once moved, nothing is
 * keyed to the old ministry any more, so a redelivery finds nothing.
 */
export async function applySuccession(tx: Tx, e: OrgSucceeded, deps: SuccessionDeps): Promise<SuccessionCounts> {
  if (!e.moveCalendar) return { activities: 0, contacts: 0 };
  const from = e.key;
  const to = e.successorKeys[0]!;
  const at = new Date(e.at);
  const tz = deps.rules.timeZone;
  const now = await dbNow(tx);
  const nameOf = async (key: string) => (await tx.select({ name: orgs.displayName }).from(orgs).where(eq(orgs.key, key)))[0]?.name ?? key;
  const [oldName, newName] = [await nameOf(from), await nameOf(to)];

  // Ascending ids, locked as a transfer locks them, so the two never wait on each other in a cycle.
  const ids = (await tx.select({ id: activities.id }).from(activities).where(movable(from, at, tz)).orderBy(asc(activities.id))).map((r) => r.id);
  let moved = 0;
  for (const id of ids) {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    // Re-check under the lock: a save or a transfer may have got there first.
    if (!s || s.row.deletedAt || s.row.contactMinistryKey !== from) continue;
    await tx.update(activities).set({ contactMinistryKey: to, version: s.row.version + 1 }).where(eq(activities.id, id));
    await tx.execute(sql`INSERT INTO ${activitySharedWith} (activity_id, ministry_key) SELECT activity_id, ${to} FROM ${activitySharedWith} WHERE activity_id = ${id} AND ministry_key = ${from} ON CONFLICT DO NOTHING`);
    await tx.delete(activitySharedWith).where(and(eq(activitySharedWith.activityId, id), eq(activitySharedWith.ministryKey, from)));
    await writeChange(tx, {
      activityId: id, actor: SYSTEM_ACTOR, action: "updated", contactMinistryKey: to, at: now,
      fields: [{ key: "contact_ministry", old: oldName, new: newName }],
    });
    await emitActivity(tx, deps, id, "activity.updated");
    moved++;
  }

  const contacts = await tx.select().from(commContacts).where(movableContacts(from));
  const taken = contacts.length
    ? new Set((await tx.select({ userId: commContacts.userId }).from(commContacts).where(and(eq(commContacts.ministryKey, to), inArray(commContacts.userId, contacts.map((c) => c.userId))))).map((r) => r.userId))
    : new Set<string>();
  for (const c of contacts) {
    if (taken.has(c.userId)) await tx.update(commContacts).set({ isActive: false }).where(eq(commContacts.id, c.id));
    else await tx.update(commContacts).set({ ministryKey: to }).where(eq(commContacts.id, c.id));
  }
  return { activities: moved, contacts: contacts.length };
}
