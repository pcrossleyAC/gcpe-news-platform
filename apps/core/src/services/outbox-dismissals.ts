import { desc } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { UndeliveredUpdate } from "@gcpe/events";
import { outboxDismissals } from "../db/schema";

/** A dismissed undelivered update, as the Hub's Undelivered updates screen lists it. */
export interface Dismissal {
  app: string;
  eventId: string;
  subscriber: string;
  type: string;
  about: string | null;
  lastError: string | null;
  /** When the update was queued (ISO). */
  createdAt: string;
  replaced: boolean;
  /** When it was dismissed (ISO), and by whom. */
  dismissedAt: string;
  dismissedBy: string;
}

/**
 * Suite review fix round 1, M1: records who dismissed these undelivered updates of `app`'s outbox.
 * The first record of one wins (a repeat changes nothing).
 */
export async function recordDismissals(db: Db, app: string, updates: UndeliveredUpdate[], actor: { id: string; name: string }): Promise<void> {
  if (updates.length === 0) return;
  await db
    .insert(outboxDismissals)
    .values(
      updates.map((u) => ({
        app,
        eventId: u.eventId,
        subscriber: u.subscriber,
        eventType: u.type,
        about: u.about,
        lastError: u.lastError,
        queuedAt: new Date(u.createdAt),
        replaced: u.replaced,
        actorId: actor.id,
        actorName: actor.name,
      })),
    )
    .onConflictDoNothing();
}

/** The most recent dismissals, newest first. */
export async function recentDismissals(db: Db, limit: number): Promise<Dismissal[]> {
  const rows = await db.select().from(outboxDismissals).orderBy(desc(outboxDismissals.dismissedAt), outboxDismissals.app, outboxDismissals.eventId).limit(limit);
  return rows.map((r) => ({
    app: r.app,
    eventId: r.eventId,
    subscriber: r.subscriber,
    type: r.eventType,
    about: r.about,
    lastError: r.lastError,
    createdAt: r.queuedAt.toISOString(),
    replaced: r.replaced,
    dismissedAt: r.dismissedAt.toISOString(),
    dismissedBy: r.actorName,
  }));
}
