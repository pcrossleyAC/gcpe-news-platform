import type { Db } from "@gcpe/db-kit";
import type { ChangeAction, ChangeSource } from "@gcpe/calendar-contract";
import { activities, activityChangeFields, activityChanges, activitySharedWith } from "../src/db/schema";
import { insertRaw } from "./world";

/** A BC wall-clock instant. BC is UTC−7 from 2026-11-01 on, and was UTC−8 in winter before that. */
export const bcAt = (date: string, time: string, offset = "-07:00") => new Date(`${date}T${time}:00${offset}`);

export type FeedKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
/** Legacy-sized ids: a keyword names an activity only above 10,000. */
export const FEED_IDS: Record<FeedKey, number> = { A: 20001, B: 20002, C: 20003, D: 20004, E: 20005, F: 20006, G: 20007, H: 20008 };
export const feedKeyOf = (id: number): string => (Object.keys(FEED_IDS) as FeedKey[]).find((k) => FEED_IDS[k] === id) ?? String(id);

/** One history entry as the Calendar writes it, at a chosen time. */
export async function addEntry(
  db: Db,
  activityId: number,
  action: ChangeAction,
  at: Date,
  o: { actor?: string; source?: ChangeSource; fields?: [string, string | null, string | null][] } = {},
): Promise<void> {
  const [row] = await db
    .insert(activityChanges)
    .values({ activityId, at, actorId: null, actorName: o.actor ?? "Sample Writer", action, source: o.source ?? "calendar", contactMinistryKey: null })
    .returning({ id: activityChanges.id });
  if (o.fields?.length) {
    await db.insert(activityChangeFields).values(o.fields.map(([fieldKey, oldValue, newValue]) => ({ changeId: row!.id, fieldKey, oldValue, newValue })));
  }
}

/**
 * Eight activities and their history over 2026-11-01..03; under FIXED_NOW, today is 2026-11-03.
 * A Health; B Health confidential; C Finance; D Finance confidential; E Finance confidential shared
 * with Health; F Health, deleted; G Health, with an entry that changed only a Look Ahead field and
 * one that changed a Look Ahead field and the title; H Finance, a clone. Plus three entries the feed
 * never shows: a transfer, an LA status clear and an imported legacy log entry.
 */
export async function seedFeed(db: Db): Promise<void> {
  const make = (k: FeedKey, over: Partial<typeof activities.$inferInsert> = {}) => insertRaw(db, { id: FEED_IDS[k], title: `Feed ${k}`, details: `Sample details ${k}`, ...over });
  await make("A");
  await make("B", { isConfidential: true });
  await make("C", { contactMinistryKey: "finance" });
  await make("D", { contactMinistryKey: "finance", isConfidential: true });
  await make("E", { contactMinistryKey: "finance", isConfidential: true });
  await db.insert(activitySharedWith).values({ activityId: FEED_IDS.E, ministryKey: "health" });
  await make("F", { deletedAt: bcAt("2026-11-03", "09:00"), needsReview: ["active"] });
  await make("G");
  await make("H", { contactMinistryKey: "finance" });

  const e = (k: FeedKey, action: ChangeAction, date: string, time: string, o: Parameters<typeof addEntry>[4] = {}) => addEntry(db, FEED_IDS[k], action, bcAt(date, time), o);
  await e("A", "updated", "2019-05-01", "09:00", { source: "legacy_log", fields: [["title", "Feed A older", "Feed A old"]] });
  await e("A", "created", "2026-11-01", "09:00");
  await e("C", "created", "2026-11-01", "09:05");
  await e("B", "created", "2026-11-02", "09:00");
  await e("D", "created", "2026-11-02", "09:10");
  await e("E", "created", "2026-11-02", "09:20");
  await e("A", "updated", "2026-11-02", "14:00", { fields: [["title", "Feed A old", "Feed A"]] });
  await e("F", "created", "2026-11-03", "08:00");
  await e("F", "deleted", "2026-11-03", "09:00");
  await e("A", "reviewed", "2026-11-03", "09:30", { actor: "Sample Reviewer", fields: [["status", "Changed", "Reviewed"]] });
  await e("H", "cloned", "2026-11-03", "09:45", { fields: [["cloned_from", null, String(FEED_IDS.C)]] });
  await e("G", "created", "2026-11-03", "10:00");
  await e("G", "updated", "2026-11-03", "10:30", { fields: [["hq_comments", null, "Sample executive summary"]] });
  await e("C", "transferred", "2026-11-03", "10:40", { fields: [["comm_contact", "Kim Finance (FIN)", "Sample Admin (HLTH)"]] });
  await e("A", "la_status_cleared", "2026-11-03", "10:50", { fields: [["hq_status", "Changed", null]] });
  await e("G", "updated", "2026-11-03", "10:55", { fields: [["title", "Feed G old", "Feed G"], ["hq_status", null, "New"]] });
}
