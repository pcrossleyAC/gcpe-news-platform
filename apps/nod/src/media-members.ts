/**
 * Media list membership (4c Task 2, spec §5.3): a member is a `subscriptions` row on the
 * email-unique `subscribers` row for that address, whose list key is in the
 * `media-distribution-lists` category (global constraints, "Members").
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { lists, subscribers, subscriptions, type SubscriberSource, type SubscriptionRow } from "./db/schema";
import { MEDIA_CATEGORY, mediaListKey } from "./lists";
import { writeHistory } from "./subscribe/history";
import { normaliseEmail } from "./subscribe/info";

/** → HTTP 404: no active-or-not media list with that key in the `media-distribution-lists` category. */
export class MediaListNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`No media list with key "${key}".`);
  }
}

/** → HTTP 409 `{ error: "opted-out", at }`: the address left this subscriber's lists by
 * unsubscribing more recently than it was last added to a media list, and the caller didn't
 * pass `confirmOptOut`. */
export class OptedOutError extends Error {
  constructor(public readonly at: Date) {
    super("opted-out");
  }
}

export interface AddMediaMemberInput {
  email: string;
  source: Extract<SubscriberSource, "media-hub" | "manual-media">;
  mediaHubContactId?: number;
  mediaHubEmailRef?: string;
  /** Required (and must be true) to re-add someone who opted out since their last media-list add. */
  confirmOptOut?: boolean;
}

export interface MediaMember {
  subscriberId: string;
  email: string;
  source: string;
  mediaHubContactId: number | null;
  needsAttention: string | null;
}

export interface MediaListSummary {
  listKey: string;
  key: string;
  name: string;
  active: boolean;
  members: number;
}

async function mediaListRow(tx: DbOrTx, key: string): Promise<{ listKey: string } | null> {
  const [row] = await tx.select({ listKey: lists.listKey }).from(lists).where(and(eq(lists.listKey, key), eq(lists.category, MEDIA_CATEGORY)));
  return row ?? null;
}

/** Latest `subscriber_history` row's `at` for `action` on this subscriber, or null. */
async function latestHistoryAt(tx: DbOrTx, subscriberId: string, action: string): Promise<Date | null> {
  const r = await tx.execute<{ at: string | Date }>(sql`
    SELECT at FROM subscriber_history WHERE subscriber_id = ${subscriberId} AND action = ${action}
    ORDER BY at DESC LIMIT 1`);
  const at = r.rows[0]?.at;
  return at === undefined ? null : new Date(at);
}

/** True if `subscriberId` currently has at least one subscription in the media category. */
export async function hasMediaMemberships(tx: DbOrTx, subscriberId: string): Promise<boolean> {
  const rows = await tx
    .select({ listKey: subscriptions.listKey })
    .from(subscriptions)
    .where(and(eq(subscriptions.subscriberId, subscriberId), sql`${subscriptions.listKey} LIKE ${`${MEDIA_CATEGORY}:%`}`))
    .limit(1);
  return rows.length > 0;
}

/** Deletes every media subscription for `subscriberId`, writing `media-list-opted-out` history
 * (detail: the list key) for each. Called from inside `endSubscriber`'s transaction so an
 * unsubscribe -- one-click, link, or any email kind -- is also an opt-out from every media list
 * (global constraints, "Unsubscribe means everything"). */
export async function optOutMediaMemberships(tx: DbOrTx, subscriberId: string, actor: string): Promise<void> {
  const removed = await tx
    .delete(subscriptions)
    .where(and(eq(subscriptions.subscriberId, subscriberId), sql`${subscriptions.listKey} LIKE ${`${MEDIA_CATEGORY}:%`}`))
    .returning({ listKey: subscriptions.listKey });
  for (const { listKey } of removed) await writeHistory(tx, subscriberId, actor, "media-list-opted-out", listKey);
}

/**
 * Adds (or reactivates) a media list member, in one transaction. Lowercases the email; finds
 * the subscriber by email or inserts a new one, active at once, with no timing flags and no
 * public subscriptions (C51 -- staff/media-list additions never send a verification email).
 *
 * A found subscriber that's `deleted` and opted out more recently than their last
 * `media-list-added` needs `confirmOptOut: true`, else throws {@link OptedOutError}. Otherwise an
 * existing subscriber's `source`, timing flags and public subscriptions are left untouched;
 * only their status (when not already active), `ended_at`, and the given Media Hub fields move.
 */
export async function addMediaMember(db: Db, listKey: string, input: AddMediaMemberInput, actor: string): Promise<{ subscriberId: string; created: boolean }> {
  const key = mediaListKey(listKey);
  const email = normaliseEmail(input.email);
  return db.transaction(async (tx) => {
    if (!(await mediaListRow(tx, key))) throw new MediaListNotFoundError(listKey);

    const [existing] = await tx.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`);
    let subscriberId: string;
    let created = false;

    if (existing) {
      if (existing.status === "deleted") {
        const unsubscribedAt = await latestHistoryAt(tx, existing.id, "unsubscribed");
        const addedAt = await latestHistoryAt(tx, existing.id, "media-list-added");
        const optedOut = unsubscribedAt !== null && (addedAt === null || unsubscribedAt > addedAt);
        if (optedOut && !input.confirmOptOut) throw new OptedOutError(unsubscribedAt!);
      }
      subscriberId = existing.id;
      const fields: Partial<typeof subscribers.$inferInsert> = { endedAt: null };
      if (existing.status === "pending" || existing.status === "deleted" || existing.status === "disabled") fields.status = "active";
      if (input.mediaHubContactId !== undefined) fields.mediaHubContactId = input.mediaHubContactId;
      if (input.mediaHubEmailRef !== undefined) fields.mediaHubEmailRef = input.mediaHubEmailRef;
      await tx.update(subscribers).set(fields).where(eq(subscribers.id, subscriberId));
    } else {
      const [row] = await tx
        .insert(subscribers)
        .values({
          email,
          status: "active",
          source: input.source,
          asItHappens: false,
          digest: false,
          mediaHubContactId: input.mediaHubContactId ?? null,
          mediaHubEmailRef: input.mediaHubEmailRef ?? null,
        })
        .returning({ id: subscribers.id });
      subscriberId = row!.id;
      created = true;
    }

    await tx.insert(subscriptions).values({ subscriberId, listKey: key }).onConflictDoNothing();
    await writeHistory(tx, subscriberId, actor, "media-list-added", key);
    return { subscriberId, created };
  });
}

/**
 * Removes one media list membership, writing `media-list-removed` history. If the subscriber
 * was added only for media (`source` `media-hub` or `manual-media`) and this was their last
 * media subscription, ends them the way an unsubscribe does (`status: 'deleted'`, `ended_at`,
 * history `unsubscribed`) -- there's nothing left for a staff-only subscriber to be active for.
 * Returns whether a membership was actually removed.
 */
export async function removeMediaMember(db: Db, listKey: string, subscriberId: string, actor: string): Promise<boolean> {
  const key = mediaListKey(listKey);
  return db.transaction(async (tx) => {
    const removed: SubscriptionRow[] = await tx
      .delete(subscriptions)
      .where(and(eq(subscriptions.subscriberId, subscriberId), eq(subscriptions.listKey, key)))
      .returning();
    if (!removed.length) return false;
    await writeHistory(tx, subscriberId, actor, "media-list-removed", key);

    const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    if (s && (s.source === "media-hub" || s.source === "manual-media") && s.status !== "deleted" && !(await hasMediaMemberships(tx, subscriberId))) {
      await tx.update(subscribers).set({ status: "deleted", endedAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
      await writeHistory(tx, subscriberId, actor, "unsubscribed");
    }
    return true;
  });
}

/** Every member of `listKey`, for the staff member-management screen. */
export async function listMediaMembers(db: DbOrTx, listKey: string): Promise<MediaMember[]> {
  const key = mediaListKey(listKey);
  if (!(await mediaListRow(db, key))) throw new MediaListNotFoundError(listKey);
  return db
    .select({
      subscriberId: subscribers.id,
      email: subscribers.email,
      source: subscribers.source,
      mediaHubContactId: subscribers.mediaHubContactId,
      needsAttention: subscribers.needsAttention,
    })
    .from(subscriptions)
    .innerJoin(subscribers, eq(subscribers.id, subscriptions.subscriberId))
    .where(eq(subscriptions.listKey, key))
    .orderBy(asc(subscribers.email));
}

/** Every media list, with a live member count, for the staff media-lists screen. */
export async function listMediaLists(db: DbOrTx): Promise<MediaListSummary[]> {
  return db
    .select({
      listKey: lists.listKey,
      key: lists.key,
      name: lists.name,
      active: lists.active,
      members: sql<number>`count(${subscriptions.subscriberId})::int`,
    })
    .from(lists)
    .leftJoin(subscriptions, eq(subscriptions.listKey, lists.listKey))
    .where(eq(lists.category, MEDIA_CATEGORY))
    .groupBy(lists.listKey, lists.key, lists.name, lists.active, lists.sortOrder)
    .orderBy(asc(lists.sortOrder), asc(lists.name));
}
