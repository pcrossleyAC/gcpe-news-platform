import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { mediaOptOuts, type SubscriberRow } from "./db/schema";
import { MEDIA_CATEGORY } from "./lists";
import { normaliseEmail } from "./subscribe/info";

/** The list key of a kept opt-out from every media list: an ended record's own unsubscribe. */
export const ALL_MEDIA_LISTS = "*";

/**
 * The key a media-list opt-out is kept under once the subscriber row is purged: SHA-256 of the
 * lowercased address under a fixed prefix. Unkeyed on purpose: rotating LINK_SECRET (the
 * response to a leaked unsubscribe token) must never forget anyone's opt-out.
 */
export function optOutHash(email: string): string {
  return createHash("sha256").update(`gcpe-nod-media-opt-out:${normaliseEmail(email)}`).digest("hex");
}

/** Latest `subscriber_history` row's `at` for `action` on this subscriber (and, when given,
 * with that `detail`), or null. */
async function latestHistoryAt(tx: DbOrTx, subscriberId: string, action: string, detail?: string): Promise<Date | null> {
  const r = await tx.execute<{ at: string | Date }>(sql`
    SELECT at FROM subscriber_history
     WHERE subscriber_id = ${subscriberId} AND action = ${action} ${detail === undefined ? sql`` : sql`AND detail = ${detail}`}
     ORDER BY at DESC LIMIT 1`);
  const at = r.rows[0]?.at;
  return at === undefined ? null : new Date(at);
}

const newerOrTie = (a: Date | null, b: Date | null): boolean => a !== null && (b === null || a >= b);
const latest = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null || a >= b ? a : b);

/** When this subscriber left media list `key` by their own choice, if that's more recent than
 * staff last added them to it: a `media-list-opted-out` for this key, or an `unsubscribed` that
 * came after their last add to it with no staff removal in between (so the membership was
 * still live when they unsubscribed). Ties fail closed. */
async function optedOutOfKey(tx: DbOrTx, subscriberId: string, key: string): Promise<Date | null> {
  const addedToKey = await latestHistoryAt(tx, subscriberId, "media-list-added", key);
  const optedOutOfKey = await latestHistoryAt(tx, subscriberId, "media-list-opted-out", key);
  if (newerOrTie(optedOutOfKey, addedToKey)) return optedOutOfKey;

  const unsubscribedAt = await latestHistoryAt(tx, subscriberId, "unsubscribed");
  if (addedToKey !== null && newerOrTie(unsubscribedAt, addedToKey)) {
    const removedFromKey = await latestHistoryAt(tx, subscriberId, "media-list-removed", key);
    if (removedFromKey === null || removedFromKey < addedToKey) return unsubscribedAt;
  }
  return null;
}

/** A deleted subscriber also counts as opted out of every media list after an `unsubscribed`
 * newer than their last add to any media list. Ties fail closed. */
async function optedOutOfAll(tx: DbOrTx, subscriberId: string): Promise<Date | null> {
  const unsubscribedAt = await latestHistoryAt(tx, subscriberId, "unsubscribed");
  return newerOrTie(unsubscribedAt, await latestHistoryAt(tx, subscriberId, "media-list-added")) ? unsubscribedAt : null;
}

/**
 * When this subscriber last left media list `key` by their own choice, if that's more recent
 * than staff last added them to it -- else null. Checked whatever their current status: someone
 * who unsubscribed and has since re-subscribed to public news has not thereby asked to be back
 * on a media list. A deleted subscriber also counts as opted out of every list after an
 * `unsubscribed` newer than their last add to any media list.
 */
export async function optedOutOf(tx: DbOrTx, subscriberId: string, key: string, deleted: boolean): Promise<Date | null> {
  return (await optedOutOfKey(tx, subscriberId, key)) ?? (deleted ? await optedOutOfAll(tx, subscriberId) : null);
}

/**
 * Copies into media_opt_outs, under the address's hash, every opt-out {@link optedOutOf} would
 * enforce for this subscriber: one row per media list they left, and an every-list row when the
 * record has ended after its own unsubscribe. Called inside the purge's per-subscriber
 * transaction, just before the row is deleted, so a purge never quietly undoes an opt-out.
 * Returns the number of rows written.
 */
export async function keepMediaOptOuts(tx: DbOrTx, s: Pick<SubscriberRow, "id" | "email" | "status">): Promise<number> {
  const keys = await tx.execute<{ detail: string }>(sql`
    SELECT DISTINCT detail FROM subscriber_history
     WHERE subscriber_id = ${s.id} AND action IN ('media-list-added', 'media-list-opted-out') AND detail LIKE ${`${MEDIA_CATEGORY}:%`}`);
  const kept: { listKey: string; at: Date }[] = [];
  for (const { detail } of keys.rows) {
    const at = await optedOutOfKey(tx, s.id, detail);
    if (at) kept.push({ listKey: detail, at });
  }
  if (s.status === "deleted") {
    const at = await optedOutOfAll(tx, s.id);
    if (at) kept.push({ listKey: ALL_MEDIA_LISTS, at });
  }
  if (kept.length === 0) return 0;
  const hash = optOutHash(s.email);
  await tx
    .insert(mediaOptOuts)
    .values(kept.map((k) => ({ emailHash: hash, listKey: k.listKey, optedOutAt: k.at })))
    .onConflictDoUpdate({
      target: [mediaOptOuts.emailHash, mediaOptOuts.listKey],
      set: { optedOutAt: sql`GREATEST(${mediaOptOuts.optedOutAt}, EXCLUDED.opted_out_at)` },
    });
  return kept.length;
}

/** The latest opt-out kept for this address from `listKey` or from every list, or null. */
export async function suppressedOptOutAt(tx: DbOrTx, email: string, listKey: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: sql<string | null>`max(${mediaOptOuts.optedOutAt})` })
    .from(mediaOptOuts)
    .where(and(eq(mediaOptOuts.emailHash, optOutHash(email)), inArray(mediaOptOuts.listKey, [listKey, ALL_MEDIA_LISTS])));
  return row?.at ? new Date(row.at) : null;
}

/**
 * Whether adding this address to media list `key` needs staff to confirm, and since when: the
 * opt-out on the subscriber's own record ({@link optedOutOf}), or one kept from a purged record
 * of the same address. A kept opt-out stops counting once staff have added this record to that
 * list (or, for an every-list one, to any media list) since -- the same rule as a live one.
 */
export async function mediaOptOutAt(
  tx: DbOrTx,
  email: string,
  key: string,
  existing: Pick<SubscriberRow, "id" | "status"> | null,
): Promise<Date | null> {
  const live = existing ? await optedOutOf(tx, existing.id, key, existing.status === "deleted") : null;
  const hash = optOutHash(email);
  const rows = await tx
    .select({ listKey: mediaOptOuts.listKey, at: mediaOptOuts.optedOutAt })
    .from(mediaOptOuts)
    .where(and(eq(mediaOptOuts.emailHash, hash), inArray(mediaOptOuts.listKey, [key, ALL_MEDIA_LISTS])));
  let kept: Date | null = null;
  for (const row of rows) {
    const since = existing ? await latestHistoryAt(tx, existing.id, "media-list-added", row.listKey === ALL_MEDIA_LISTS ? undefined : key) : null;
    if (newerOrTie(row.at, since)) kept = latest(kept, row.at);
  }
  return latest(live, kept);
}
