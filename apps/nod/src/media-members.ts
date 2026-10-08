/**
 * Media list membership (4c Task 2, spec §5.3): a member is a `subscriptions` row on the
 * email-unique `subscribers` row for that address, whose list key is in the
 * `media-distribution-lists` category (global constraints, "Members").
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { lists, subscribers, subscriptions, type SubscriberSource, type SubscriptionRow } from "./db/schema";
import { MEDIA_CATEGORY, mediaListKey } from "./lists";
import { lockAddress, withLockedSubscriber } from "./locks";
import { mediaOptOutAt } from "./opt-outs";
import { writeHistory } from "./subscribe/history";
import { normaliseEmail } from "./subscribe/info";

/** → HTTP 404: no active-or-not media list with that key in the `media-distribution-lists` category. */
export class MediaListNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`No media list with key "${key}".`);
  }
}

/** → HTTP 409 `{ error: "opted-out", at }`: the address left this media list by its own choice
 * more recently than staff last added it, and the caller didn't pass `confirmOptOut`. */
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
  /** The chosen Media Hub email's ref; what the resolve screen preselects against. */
  mediaHubEmailRef: string | null;
  needsAttention: string | null;
  attentionAt: Date | null;
}

export interface MediaListSummary {
  listKey: string;
  key: string;
  name: string;
  active: boolean;
  members: number;
  /** Members with a needs-attention flag (C59): what the index screen surfaces first. */
  needsAttention: number;
}

async function mediaListRow(tx: DbOrTx, key: string): Promise<{ listKey: string } | null> {
  const [row] = await tx.select({ listKey: lists.listKey }).from(lists).where(and(eq(lists.listKey, key), eq(lists.category, MEDIA_CATEGORY)));
  return row ?? null;
}

/** True if `subscriberId` has any subscription left, media or public. */
async function hasAnySubscriptions(tx: DbOrTx, subscriberId: string): Promise<boolean> {
  const rows = await tx.select({ listKey: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId)).limit(1);
  return rows.length > 0;
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
 * Takes the per-address advisory lock (same keyspace as 4a's journeys) before reading the
 * subscriber row `FOR UPDATE`, so a concurrent add of the same new address never double-inserts
 * and an add can never race a concurrent unsubscribe into reading a stale, not-yet-opted-out row.
 *
 * A found subscriber who left this list by their own choice since staff last added them to it
 * (opt-outs.ts `optedOutOf` -- whatever their status now, so a public re-subscribe doesn't count
 * as consent), or an address with an opt-out kept from a purged record (opt-outs.ts
 * `mediaOptOutAt`, whether or not it has a new record since), needs `confirmOptOut: true`, else
 * throws {@link OptedOutError}.
 * Reactivating a `deleted` subscriber -- confirmed opt-out or not (they may simply never have
 * resubscribed publicly since) -- must not restart their old public mail: their timing flags are
 * reset to off and their non-media subscriptions are dropped. From `pending`/`disabled`, public
 * state is left untouched. `source` is never changed on an existing row.
 *
 */
export async function addMediaMember(db: Db, listKey: string, input: AddMediaMemberInput, actor: string): Promise<{ subscriberId: string; created: boolean }> {
  const key = mediaListKey(listKey);
  const email = normaliseEmail(input.email);
  return db.transaction(async (tx) => {
    await lockAddress(tx, email);
    if (!(await mediaListRow(tx, key))) throw new MediaListNotFoundError(listKey);

    const [existing] = await tx.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`).for("update");
    // The record's own opt-out, or one kept from a purged record of this address (opt-outs.ts).
    if (!input.confirmOptOut) {
      const optedOutAt = await mediaOptOutAt(tx, email, key, existing ?? null);
      if (optedOutAt) throw new OptedOutError(optedOutAt);
    }
    let subscriberId: string;
    let created = false;

    if (existing) {
      const wasDeleted = existing.status === "deleted";
      subscriberId = existing.id;
      const fields: Partial<typeof subscribers.$inferInsert> = { endedAt: null };
      if (existing.status === "pending" || existing.status === "deleted" || existing.status === "disabled") fields.status = "active";
      if (input.mediaHubContactId !== undefined) fields.mediaHubContactId = input.mediaHubContactId;
      if (input.mediaHubEmailRef !== undefined) fields.mediaHubEmailRef = input.mediaHubEmailRef;
      if (wasDeleted) {
        fields.asItHappens = false;
        fields.digest = false;
      }
      await tx.update(subscribers).set(fields).where(eq(subscribers.id, subscriberId));
      if (wasDeleted) {
        await tx
          .delete(subscriptions)
          .where(and(eq(subscriptions.subscriberId, subscriberId), sql`${subscriptions.listKey} NOT LIKE ${`${MEDIA_CATEGORY}:%`}`));
      }
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
 * was added only for media (`source` `media-hub` or `manual-media`) and *no subscription of any
 * kind* -- media or public -- remains, ends them the way an unsubscribe does (`status:
 * 'deleted'`, `ended_at`), but writes history `media-ended`, never `unsubscribed`: that action is
 * reserved for the subscriber's own unsubscribe, since `addMediaMember`'s opt-out check reads it
 * (a media-created subscriber who picked up a public subscription via `update()` keeps their own
 * mail; and a staff-ended member can be re-added without `confirmOptOut`). Runs under the
 * shared lock discipline (locks.ts `withLockedSubscriber`), so two concurrent removes of a
 * subscriber's last two lists end them exactly once, and a remove that waited out a change of
 * address re-locks the new one. Returns whether a membership was actually removed.
 */
export async function removeMediaMember(db: Db, listKey: string, subscriberId: string, actor: string): Promise<boolean> {
  const key = mediaListKey(listKey);
  return withLockedSubscriber(db, subscriberId, null, async (tx, s) => {
    if (!s) return false;

    const removed: SubscriptionRow[] = await tx
      .delete(subscriptions)
      .where(and(eq(subscriptions.subscriberId, subscriberId), eq(subscriptions.listKey, key)))
      .returning();
    if (!removed.length) return false;
    await writeHistory(tx, subscriberId, actor, "media-list-removed", key);

    if ((s.source === "media-hub" || s.source === "manual-media") && s.status !== "deleted" && !(await hasAnySubscriptions(tx, subscriberId))) {
      await tx.update(subscribers).set({ status: "deleted", endedAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
      await writeHistory(tx, subscriberId, actor, "media-ended");
    }
    return true;
  });
}

/** Every member of `listKey`, for the staff member-management screen. Not paged: media lists
 * hold hundreds of members, and legacy showed them all on one page. */
export async function listMediaMembers(db: DbOrTx, listKey: string): Promise<MediaMember[]> {
  const key = mediaListKey(listKey);
  if (!(await mediaListRow(db, key))) throw new MediaListNotFoundError(listKey);
  return db
    .select({
      subscriberId: subscribers.id,
      email: subscribers.email,
      source: subscribers.source,
      mediaHubContactId: subscribers.mediaHubContactId,
      mediaHubEmailRef: subscribers.mediaHubEmailRef,
      needsAttention: subscribers.needsAttention,
      attentionAt: subscribers.attentionAt,
    })
    .from(subscriptions)
    .innerJoin(subscribers, eq(subscribers.id, subscriptions.subscriberId))
    .where(eq(subscriptions.listKey, key))
    .orderBy(asc(subscribers.email));
}

/** Every media list, with live member and needs-attention counts, for the staff media-lists screen. */
export async function listMediaLists(db: DbOrTx): Promise<MediaListSummary[]> {
  return db
    .select({
      listKey: lists.listKey,
      key: lists.key,
      name: lists.name,
      active: lists.active,
      members: sql<number>`count(${subscriptions.subscriberId})::int`,
      needsAttention: sql<number>`count(${subscribers.id}) FILTER (WHERE ${subscribers.needsAttention} IS NOT NULL)::int`,
    })
    .from(lists)
    .leftJoin(subscriptions, eq(subscriptions.listKey, lists.listKey))
    .leftJoin(subscribers, eq(subscribers.id, subscriptions.subscriberId))
    .where(eq(lists.category, MEDIA_CATEGORY))
    .groupBy(lists.listKey, lists.key, lists.name, lists.active, lists.sortOrder)
    .orderBy(asc(lists.sortOrder), asc(lists.name));
}

/** How many opt-outs the per-list view returns; the newest are what staff act on. */
export const OPT_OUT_LIMIT = 200;

export interface MediaOptOut {
  subscriberId: string;
  /** The subscriber's current address (it may have moved since they opted out). */
  email: string;
  at: Date;
  /** Whether they're on this list again now (re-added by staff with confirmation). */
  member: boolean;
}

/**
 * Who left `listKey` by unsubscribing (history `media-list-opted-out`, whose detail is the full
 * list key), newest first, at most {@link OPT_OUT_LIMIT}. One row per subscriber, for their latest
 * opt-out: someone re-added and opted out again is still one person to act on. Staff removals
 * are not opt-outs and never appear here (C82). Served by subscriber_history_action_detail_at_idx.
 */
export async function listMediaOptOuts(db: DbOrTx, listKey: string): Promise<{ items: MediaOptOut[]; truncated: boolean }> {
  const key = mediaListKey(listKey);
  if (!(await mediaListRow(db, key))) throw new MediaListNotFoundError(listKey);
  const { rows } = await db.execute<{ subscriber_id: string; email: string; at: string | Date; member: boolean }>(sql`
    SELECT latest.subscriber_id, s.email, latest.at,
           EXISTS (SELECT 1 FROM subscriptions x WHERE x.subscriber_id = latest.subscriber_id AND x.list_key = ${key}) AS member
      FROM (SELECT DISTINCT ON (h.subscriber_id, h.detail) h.subscriber_id, h.at
              FROM subscriber_history h
             WHERE h.action = 'media-list-opted-out' AND h.detail = ${key}
             ORDER BY h.subscriber_id, h.detail, h.at DESC) latest
      JOIN subscribers s ON s.id = latest.subscriber_id
     ORDER BY latest.at DESC
     LIMIT ${OPT_OUT_LIMIT + 1}`);
  return {
    items: rows.slice(0, OPT_OUT_LIMIT).map((r) => ({ subscriberId: r.subscriber_id, email: r.email, at: new Date(r.at), member: r.member })),
    truncated: rows.length > OPT_OUT_LIMIT,
  };
}
