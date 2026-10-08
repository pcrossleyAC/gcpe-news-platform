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
  return keepOptOutHashes(tx, s.email, kept);
}

/** Writes opt-outs for an address NoD holds no record of, under its hash: one row per media list
 * key (or {@link ALL_MEDIA_LISTS}), keeping the later date when one is already kept. The caller
 * holds the address lock. Returns the number of rows written. */
export async function keepOptOutHashes(tx: DbOrTx, email: string, kept: { listKey: string; at: Date }[]): Promise<number> {
  if (kept.length === 0) return 0;
  const hash = optOutHash(email);
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

/** Every history action that moves a record onto a new address. */
const ADDRESS_CHANGES = ["email-changed", "staff-email-changed", "media-hub-email-changed", "legacy-email-changed"];

/** When this record took the address it holds now: its latest move, or null if it never moved. */
async function addressTakenAt(tx: DbOrTx, subscriberId: string): Promise<Date | null> {
  const r = await tx.execute<{ at: string | Date | null }>(sql`
    SELECT max(at) AS at FROM subscriber_history
     WHERE subscriber_id = ${subscriberId} AND action IN (${sql.join(ADDRESS_CHANGES.map((a) => sql`${a}`), sql`, `)})`);
  const at = r.rows[0]?.at;
  return at ? new Date(at) : null;
}

/**
 * Whether putting this address on media list `key` needs staff to confirm, and since when: the
 * opt-out on the subscriber's own record ({@link optedOutOf}), or one kept for the address from
 * a purged record of it. A kept opt-out stops counting once staff have added this record to that
 * list (or, for an every-list one, to any media list) since -- but only an add made while the
 * record held this address: one made at an address it has since left says nothing about this
 * one. So a record that doesn't hold `email` yet (one about to move onto it) has no add that
 * counts.
 */
export async function mediaOptOutAt(
  tx: DbOrTx,
  email: string,
  key: string,
  existing: Pick<SubscriberRow, "id" | "status" | "email"> | null,
): Promise<Date | null> {
  const live = existing ? await optedOutOf(tx, existing.id, key, existing.status === "deleted") : null;
  const rows = await tx
    .select({ listKey: mediaOptOuts.listKey, at: mediaOptOuts.optedOutAt })
    .from(mediaOptOuts)
    .where(and(eq(mediaOptOuts.emailHash, optOutHash(email)), inArray(mediaOptOuts.listKey, [key, ALL_MEDIA_LISTS])));
  if (rows.length === 0) return live;
  const holdsIt = existing !== null && normaliseEmail(existing.email) === normaliseEmail(email);
  const takenAt = holdsIt ? await addressTakenAt(tx, existing.id) : null;
  let kept: Date | null = null;
  for (const row of rows) {
    const added = holdsIt ? await latestHistoryAt(tx, existing.id, "media-list-added", row.listKey === ALL_MEDIA_LISTS ? undefined : key) : null;
    const since = added !== null && (takenAt === null || added >= takenAt) ? added : null;
    if (newerOrTie(row.at, since)) kept = latest(kept, row.at);
  }
  return latest(live, kept);
}

/**
 * The media lists among `keys` that `email` may not be put on -- or a record carried onto, when
 * it moves to `email` -- without staff confirming, each with the opt-out's date
 * ({@link mediaOptOutAt}). The one rule every way onto a media list, or onto a new address
 * while on one, goes through.
 */
export async function optedOutKeys(
  tx: DbOrTx,
  email: string,
  keys: string[],
  existing: Pick<SubscriberRow, "id" | "status" | "email"> | null,
): Promise<{ listKey: string; at: Date }[]> {
  const out: { listKey: string; at: Date }[] = [];
  for (const listKey of keys) {
    if (!listKey.startsWith(`${MEDIA_CATEGORY}:`)) continue;
    const at = await mediaOptOutAt(tx, email, listKey, existing);
    if (at) out.push({ listKey, at });
  }
  return out;
}

/** The media list keys this subscriber is on now. */
export async function mediaKeysOf(tx: DbOrTx, subscriberId: string): Promise<string[]> {
  const rows = await tx.execute<{ list_key: string }>(sql`
    SELECT list_key FROM subscriptions WHERE subscriber_id = ${subscriberId} AND list_key LIKE ${`${MEDIA_CATEGORY}:%`} ORDER BY list_key`);
  return rows.rows.map((r) => r.list_key);
}
