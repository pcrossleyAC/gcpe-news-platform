import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, termEventType, type SubscriberConfig } from "@gcpe/events";
import { organizations, terms } from "../db/schema";
import { toOrgRecord } from "./organizations";
import { toTermRecord } from "./terms";

/**
 * Re-emits an upserted event for every organization and term.
 *
 * Each aggregate is republished in its own short transaction that takes the same
 * per-aggregate advisory lock as upsert/deactivate and re-reads the row under it. That
 * keeps the event's data and its sequence number consistent: an upsert that commits
 * mid-republish either finishes before we re-read (we republish its data) or waits for
 * us (its event gets the higher sequence). Reading everything up front and enqueueing
 * later would let stale data win the higher sequence.
 */
export async function republishAll(db: Db, subscribers: SubscriberConfig[]): Promise<number> {
  let count = 0;

  const orgKeys = await db.select({ key: organizations.key }).from(organizations).orderBy(asc(organizations.key));
  for (const { key } of orgKeys) {
    const done = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org:${key}`}))`);
      const [row] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
      if (!row) return false;
      const record = toOrgRecord(row);
      await enqueueEvent(tx, { type: "org.upserted", source: "core", aggregateId: `org:${record.key}`, data: record }, subscribers);
      return true;
    });
    if (done) count++;
  }

  const termKeys = await db.select({ kind: terms.kind, key: terms.key }).from(terms).orderBy(asc(terms.kind), asc(terms.key));
  for (const { kind, key } of termKeys) {
    const done = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${kind}:${key}`}))`);
      const [row] = await tx
        .select()
        .from(terms)
        .where(and(eq(terms.kind, kind), eq(terms.key, key)))
        .for("update");
      if (!row) return false;
      const record = toTermRecord(row);
      await enqueueEvent(
        tx,
        { type: termEventType(record.kind, "upserted"), source: "core", aggregateId: `${record.kind}:${record.key}`, data: record },
        subscribers,
      );
      return true;
    });
    if (done) count++;
  }

  return count;
}
