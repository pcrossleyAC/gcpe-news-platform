/**
 * Staff changes to one subscriber (spec §8). Each runs in its own transaction, takes the
 * per-address lock (locks.ts) before reading the row FOR UPDATE, and writes history with the
 * staff member's display name as the actor.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import { subscribers, subscriptions, type SubscriberRow, type SubscriberStatus } from "../db/schema";
import { activeListKeys, MEDIA_CATEGORY } from "../lists";
import { withLockedSubscriber as lockedSubscriber } from "../locks";
import { hasMediaMemberships } from "../media-members";
import { replacePublicSubscriptions } from "../subscribers";
import { writeHistory } from "../subscribe/history";
import { safeErrorLabel } from "@gcpe/http-kit";
import { normaliseEmail } from "../subscribe/info";
import { expireSessionLinks } from "../subscribe/links";

export class SubscriberNotFoundError extends Error {
  constructor() { super("not found"); }
}
/** The subscriber's current status doesn't allow this change (e.g. activating a deleted one). */
export class SubscriberStateError extends Error {
  constructor(public readonly status: SubscriberStatus) { super("status"); }
}
/** Another subscriber row — whatever its status — already has the address. */
export class EmailTakenError extends Error {
  constructor(public readonly id: string) { super("email-taken"); }
}
/** The address of a subscriber Media Hub tracks follows Media Hub: the nightly sync finds the
 * row by its contact id and rewrites the address, which would undo a staff edit. That covers a
 * Media Hub-sourced member and also a self- or admin-sourced subscriber who was later linked to
 * a Media Hub contact. It's changed in Media Hub, or re-pointed through the media list's
 * resolve action. */
export class MediaHubManagedError extends Error {
  constructor() { super("media-hub-managed"); }
}
export class StaffPreferencesError extends Error {}

export interface StaffPrefsInput { asItHappens: boolean; digest: boolean; allNews: boolean; listKeys: string[] }

export const BULK_ACTIONS = ["activate", "deactivate", "delete"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** Comfortably above one page of search results (read.ts's PAGE_SIZE). */
export const BULK_MAX = 200;
/** Why a bulk row didn't change: no such subscriber, already in the target state, a status the
 * action can't apply to, or an unexpected failure on that row alone (worth retrying). */
export type BulkSkipReason = "not-found" | "unchanged" | "status" | "error";
export interface BulkResult { changed: number; skipped: { id: string; reason: BulkSkipReason }[] }

const isMediaKey = (k: string) => k.startsWith(`${MEDIA_CATEGORY}:`);

/** The shared lock discipline (locks.ts), with a missing subscriber reported as not found. */
function withLockedSubscriber<T>(db: Db, id: string, alsoLock: string | null, work: (tx: Tx, s: SubscriberRow) => Promise<T>): Promise<T> {
  return lockedSubscriber(db, id, alsoLock, async (tx, s) => {
    if (!s) throw new SubscriberNotFoundError();
    return work(tx, s);
  });
}

/** `*`, an active list in an enabled public category, or a public key this subscriber already
 * holds even if its list has since gone inactive — so saving the form never silently drops a
 * subscription it had no checkbox for. Anything else, media keys included, is refused. */
async function allowedPublicKeys(tx: Tx, id: string, requested: string[]): Promise<string[]> {
  const wanted = [...new Set(requested.map((k) => k.trim().toLowerCase()))];
  const active = new Set(await activeListKeys(tx, wanted));
  const heldRows = await tx.select({ listKey: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, id));
  const held = new Set(heldRows.map((r) => r.listKey).filter((k) => !isMediaKey(k)));
  const refused = wanted.filter((k) => !active.has(k) && !held.has(k));
  if (refused.length) throw new StaffPreferencesError(`Not a list subscribers can choose: ${refused.join(", ")}`);
  return wanted;
}

export async function updatePreferences(db: Db, id: string, input: StaffPrefsInput, actor: string): Promise<void> {
  await withLockedSubscriber(db, id, null, async (tx, s) => {
    if (s.status !== "active" && s.status !== "disabled") throw new SubscriberStateError(s.status);
    const keys = await allowedPublicKeys(tx, id, input.allNews ? ["*"] : input.listKeys);
    const hasTiming = input.asItHappens || input.digest;
    if (keys.length > 0 && !hasTiming) throw new StaffPreferencesError("Choose As It Happens, Daily Digest, or both.");
    // Nothing public at all is only right for someone who's here for media lists alone.
    if (keys.length === 0 && (hasTiming || !(await hasMediaMemberships(tx, id)))) throw new StaffPreferencesError("Choose at least one list, or all news.");
    await tx.update(subscribers).set({ asItHappens: input.asItHappens, digest: input.digest }).where(eq(subscribers.id, id));
    await replacePublicSubscriptions(tx, id, keys);
    const timing = [input.asItHappens && "as-it-happens", input.digest && "digest"].filter(Boolean).join(", ") || "none";
    await writeHistory(tx, id, actor, "staff-preferences-updated", `${timing}; ${keys.join(", ") || "no lists"}`);
  });
}

export async function setStatus(db: Db, id: string, to: "active" | "disabled", actor: string): Promise<{ changed: boolean }> {
  return withLockedSubscriber(db, id, null, async (tx, s) => {
    if (s.status === to) return { changed: false };
    if (to === "active") {
      // Only a disabled subscriber comes back this way: a deleted one unsubscribed (only their
      // own re-subscribe restores them), and a pending one never confirmed. Coming back
      // restarts the bounce count, so bounces from before the reactivation can't re-disable them.
      if (s.status !== "disabled") throw new SubscriberStateError(s.status);
      await tx.update(subscribers).set({ status: "active", bounceWindowFrom: sql`now()` }).where(eq(subscribers.id, id));
      await writeHistory(tx, id, actor, "staff-activated");
    } else {
      if (s.status !== "active") throw new SubscriberStateError(s.status);
      await tx.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, id));
      await writeHistory(tx, id, actor, "staff-deactivated");
    }
    return { changed: true };
  });
}

/** Staff delete = unsubscribe on the subscriber's behalf: `deleted`, `ended_at` set. Media
 * memberships go too (a deleted subscriber is sent nothing, so keeping them would only inflate
 * list counts), recorded as staff removals — never `media-list-opted-out`/`unsubscribed`,
 * which mean the person themselves opted out and make a later media re-add need confirmOptOut. */
export async function deleteSubscriber(db: Db, id: string, actor: string): Promise<{ changed: boolean }> {
  return withLockedSubscriber(db, id, null, async (tx, s) => {
    if (s.status === "deleted") return { changed: false };
    await tx.update(subscribers).set({ status: "deleted", endedAt: sql`now()` }).where(eq(subscribers.id, id));
    await writeHistory(tx, id, actor, "staff-deleted");
    const removed = await tx
      .delete(subscriptions)
      .where(and(eq(subscriptions.subscriberId, id), sql`${subscriptions.listKey} LIKE ${`${MEDIA_CATEGORY}:%`}`))
      .returning({ listKey: subscriptions.listKey });
    for (const { listKey } of removed) await writeHistory(tx, id, actor, "media-list-removed", listKey);
    return { changed: true };
  });
}

/** Staff-initiated: no verification email (spec §8). Refused when any other row has the
 * address (legacy `ChangeUsersSubscriptionEmail` refuses too, and refusing means no row is ever
 * deleted and no history lost). Rotates the unsubscribe token and ends every outstanding link,
 * since those went to the old address. History records the change, never the addresses. */
export async function changeEmail(db: Db, id: string, rawEmail: string, actor: string): Promise<{ changed: boolean }> {
  const email = normaliseEmail(rawEmail);
  return withLockedSubscriber(db, id, email, async (tx, s) => {
    // A pending subscriber's only way in is the verify link sent to their address; moving the
    // address would leave a row that can never be confirmed.
    if (s.status === "deleted" || s.status === "pending") throw new SubscriberStateError(s.status);
    if (s.source === "media-hub" || s.mediaHubContactId !== null) throw new MediaHubManagedError();
    if (normaliseEmail(s.email) === email) return { changed: false };
    const [taken] = await tx.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`);
    if (taken) throw new EmailTakenError(taken.id);
    await tx.update(subscribers).set({ email, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` }).where(eq(subscribers.id, id));
    await expireSessionLinks(tx, id, null);
    await writeHistory(tx, id, actor, "staff-email-changed");
    return { changed: true };
  });
}

/** One transaction per subscriber, not one for the batch: a single transaction would hold up
 * to BULK_MAX address locks until the end and block every journey touching any of them, and
 * one row's refusal would roll back all the rest. Each outcome is reported instead — an
 * unexpected failure too, so the rows already changed are still counted. */
export async function bulkAction(db: Db, ids: string[], action: BulkAction, actor: string): Promise<BulkResult> {
  const result: BulkResult = { changed: 0, skipped: [] };
  for (const id of [...new Set(ids)]) {
    try {
      const { changed } = action === "delete" ? await deleteSubscriber(db, id, actor) : await setStatus(db, id, action === "activate" ? "active" : "disabled", actor);
      if (changed) result.changed++;
      else result.skipped.push({ id, reason: "unchanged" });
    } catch (e) {
      if (e instanceof SubscriberNotFoundError) result.skipped.push({ id, reason: "not-found" });
      else if (e instanceof SubscriberStateError) result.skipped.push({ id, reason: "status" });
      else {
        // By label only: a query error's message carries its bound parameters.
        console.error("[nod] staff bulk action failed for one subscriber", safeErrorLabel(e));
        result.skipped.push({ id, reason: "error" });
      }
    }
  }
  return result;
}
