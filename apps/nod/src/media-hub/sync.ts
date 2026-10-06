/**
 * The nightly Media Hub sync (spec §5.3): pages through Media Hub's own changes
 * feed and reconciles each changed contact against whichever local subscribers point at it
 * (`subscribers.media_hub_contact_id`), flagging what it can't safely resolve on its own
 * (global constraints, "Members" / review focus #3) instead of ever merging or dropping data.
 */
import { eq, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { dailyCutoff } from "../digest";
import { MEDIA_CATEGORY } from "../lists";
import { removeMediaMember, hasMediaMemberships } from "../media-members";
import { writeHistory } from "../subscribe/history";
import { normaliseEmail } from "../subscribe/info";
import { safeErrorLabel } from "../subscribe/journeys";
import { nodSettings, subscribers, subscriptions, type SubscriberRow } from "../db/schema";
import { MediaHubError, type MediaHubClient } from "./client";
import type { MediaHubContact } from "./contract";

/** Once per BC day at or after this local hour -- well clear of the nightly digest (17:00) and
 * any other scheduled job, same "computed like digestCutoff" shape (global constraints: clocks). */
export const MEDIA_SYNC_HOUR = 2;

export interface SyncResult {
  /** Changed contacts seen across the whole feed this run. */
  contacts: number;
  /** Subscribers whose email address moved to the contact's new chosen address. */
  updated: number;
  /** Subscribers newly flagged `needs_attention` this run (a collision or a vanished ref). */
  flagged: number;
  /** Subscribers whose memberships were removed because their contact was deleted. */
  removed: number;
  /** Contacts whose own processing failed and was skipped -- logged, never fatal to the run. */
  errors: number;
}

/** Same advisory-lock keyspace as 4a's `journeys.ts`/4c's `media-members.ts` `lockAddress`
 * (always called with a lowercased email) -- serialises this module's writes against theirs
 * for the same address. */
async function lockAddress(tx: DbOrTx, email: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${email}))`);
}

type EmailOutcome = "updated" | "email-taken" | "email-gone" | "unchanged" | "cleared";

/**
 * Reconciles one subscriber's chosen Media Hub email against `contact`'s current emails (the
 * rules in the brief's "Feed" section): the chosen ref's address moved (update, if free, else
 * flag `email-taken`), the chosen ref vanished (flag `email-gone`, keep the member -- C59), or
 * nothing changed (clearing a stale `email-gone` flag if the ref came back).
 *
 * Takes the per-address advisory lock on both the old and new address (sorted, so this can
 * never deadlock against a concurrent journeys/media-members lock taken in the other order)
 * before reading or writing anything for this subscriber.
 */
async function applyChosenEmail(tx: Tx, s: SubscriberRow, contact: MediaHubContact, actor: string): Promise<EmailOutcome> {
  const chosenRef = s.mediaHubEmailRef;
  const email = chosenRef ? contact.emails.find((e) => e.ref === chosenRef) : undefined;
  const oldAddress = normaliseEmail(s.email);

  if (!email) {
    if (s.needsAttention === "email-gone") return "unchanged";
    await lockAddress(tx, oldAddress);
    await tx.update(subscribers).set({ needsAttention: "email-gone", attentionAt: sql`now()` }).where(eq(subscribers.id, s.id));
    await writeHistory(tx, s.id, actor, "media-hub-flagged", chosenRef ?? "");
    return "email-gone";
  }

  const newAddress = normaliseEmail(email.address);
  if (newAddress === oldAddress) {
    if (s.needsAttention !== "email-gone") return "unchanged";
    await lockAddress(tx, oldAddress);
    await tx.update(subscribers).set({ needsAttention: null, attentionAt: null }).where(eq(subscribers.id, s.id));
    await writeHistory(tx, s.id, actor, "media-hub-resolved", chosenRef ?? "");
    return "cleared";
  }

  const [a, b] = [oldAddress, newAddress].sort() as [string, string];
  await lockAddress(tx, a);
  if (b !== a) await lockAddress(tx, b);

  const [existing] = await tx.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${newAddress}`);
  if (existing && existing.id !== s.id) {
    if (s.needsAttention === "email-taken") return "unchanged";
    await tx.update(subscribers).set({ needsAttention: "email-taken", attentionAt: sql`now()` }).where(eq(subscribers.id, s.id));
    await writeHistory(tx, s.id, actor, "media-hub-flagged", chosenRef ?? "");
    return "email-taken";
  }

  await tx
    .update(subscribers)
    .set({ email: newAddress, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1`, needsAttention: null, attentionAt: null })
    .where(eq(subscribers.id, s.id));
  await writeHistory(tx, s.id, actor, "media-hub-email-changed", chosenRef ?? "");
  return "updated";
}

const SYNC_ACTOR = "media-hub-sync";

/** Every local subscriber this contact affects: points at it *and* still has at least one
 * media membership (the brief: "at least one media subscription"). */
async function subscribersFor(tx: Tx, contactId: number): Promise<SubscriberRow[]> {
  const rows = await tx.select().from(subscribers).where(eq(subscribers.mediaHubContactId, contactId));
  const kept: SubscriberRow[] = [];
  for (const row of rows) if (await hasMediaMemberships(tx, row.id)) kept.push(row);
  return kept;
}

/** Applies one changed contact to every local subscriber it affects, folding each subscriber's
 * outcome into `result`. One subscriber's own failure is counted and logged (contact id only --
 * never an address, global constraints "Logs"), never aborts the run; a feed-level
 * {@link MediaHubError} from the caller's own `changes()` call is not caught here. */
async function applyContact(tx: Tx, contact: MediaHubContact, result: SyncResult): Promise<void> {
  for (const s of await subscribersFor(tx, contact.id)) {
    try {
      if (contact.deletedAt) {
        // `subscriptions.listKey` is already the full `<category>:<key>` -- removeMediaMember
        // takes the bare key and applies that prefix itself (mediaListKey), so it's stripped
        // back off here.
        const keys = await tx
          .select({ listKey: subscriptions.listKey })
          .from(subscriptions)
          .where(sql`${subscriptions.subscriberId} = ${s.id} AND ${subscriptions.listKey} LIKE ${`${MEDIA_CATEGORY}:%`}`);
        for (const { listKey } of keys) {
          await removeMediaMember(tx as unknown as Db, listKey.slice(MEDIA_CATEGORY.length + 1), s.id, SYNC_ACTOR);
        }
        result.removed += 1;
        continue;
      }
      const outcome = await applyChosenEmail(tx, s, contact, SYNC_ACTOR);
      if (outcome === "updated") result.updated += 1;
      else if (outcome === "email-taken" || outcome === "email-gone") result.flagged += 1;
    } catch (e) {
      result.errors += 1;
      console.error("[nod] media sync: contact failed", contact.id, safeErrorLabel(e));
    }
  }
}

/** Pages through `client.changes(since, cursor)` until `nextCursor` is null, applying every
 * changed contact as it goes. Left to the caller: a thrown {@link MediaHubError} from `changes`
 * itself aborts the whole run (never caught here -- see runMediaSync's own try/catch). */
async function pageThroughChanges(tx: Tx, client: MediaHubClient, since: string): Promise<SyncResult> {
  const result: SyncResult = { contacts: 0, updated: 0, flagged: 0, removed: 0, errors: 0 };
  let cursor: string | null = null;
  for (;;) {
    const page = await client.changes(since, cursor);
    for (const contact of page.contacts) {
      result.contacts += 1;
      await applyContact(tx, contact, result);
    }
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  return result;
}

const EPOCH_ISO = "1970-01-01T00:00:00Z";

/**
 * Runs one Media Hub sync attempt now, unconditionally (no "is it due" check -- that's
 * {@link runMediaSyncIfDue}). Takes `SELECT ... FROM nod_settings WHERE id = 1 FOR UPDATE`
 * first (global constraints: concurrency), so a concurrent call -- scheduled or manual --
 * queues up behind this one rather than racing it.
 *
 * The whole run (every page of the changes feed, and every contact's reconciliation) happens
 * in that one transaction: a feed-level {@link MediaHubError} rolls all of it back, so a run
 * either fully lands or leaves nothing behind, and `media_sync_since` -- the feed's own cursor
 * -- only advances once the whole feed has been processed to completion (the brief's "Feed"
 * rule). On that abort, `media_sync_at` and `media_sync_result` (`{ error }`) are still
 * recorded, in a fresh statement after the rollback (the aborted transaction's own writes are
 * gone by then) -- so a broken Media Hub doesn't get retried every tick, only once per day,
 * same as a successful run. The error is rethrown so the caller (the route, or the sync loop)
 * can act on it; its `safeErrorLabel` is log-safe (client.ts: a `MediaHubError` never carries
 * a response body, and so never an address).
 */
export async function runMediaSync(db: Db, client: MediaHubClient): Promise<SyncResult> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM nod_settings WHERE id = 1 FOR UPDATE`);
      const [settings] = await tx.select({ since: nodSettings.mediaSyncSince }).from(nodSettings).where(eq(nodSettings.id, 1));
      const since = (settings?.since ?? new Date(EPOCH_ISO)).toISOString();

      // Captured before paging starts (never after): a contact that changes mid-run must still
      // be picked up by the *next* run, which only happens if this run's new cursor is no later
      // than the instant paging began (the brief's "Feed" rule).
      const { rows } = await tx.execute<{ now: string }>(sql`SELECT now() AS now`);
      const runStart = new Date(rows[0]!.now);

      const result = await pageThroughChanges(tx, client, since);

      await tx
        .update(nodSettings)
        .set({ mediaSyncSince: runStart, mediaSyncAt: runStart, mediaSyncResult: result, updatedAt: sql`now()` })
        .where(eq(nodSettings.id, 1));
      return result;
    });
  } catch (e) {
    if (e instanceof MediaHubError) {
      const errorResult = { error: safeErrorLabel(e) };
      await db.update(nodSettings).set({ mediaSyncAt: sql`now()`, mediaSyncResult: errorResult, updatedAt: sql`now()` }).where(eq(nodSettings.id, 1));
    }
    throw e;
  }
}

/**
 * Runs {@link runMediaSync} if it's due: once per BC day at or after {@link MEDIA_SYNC_HOUR}
 * (the cutoff computed the same way as the digest's -- `dailyCutoff`, the database's own
 * `now()`, never Postgres's tzdata). Also takes the settings row `FOR UPDATE` first, in its own
 * short transaction, so two concurrent calls serialise: whichever commits first claims today's
 * window (writing a provisional `media_sync_at`) before either one starts the actual sync, so
 * the other -- once unblocked -- always sees the window already claimed and returns `ran:
 * false` (global constraints: concurrency).
 */
export async function runMediaSyncIfDue(db: Db, client: MediaHubClient, timeZone: string): Promise<{ ran: boolean; result?: SyncResult }> {
  const claimed = await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ now: string }>(sql`SELECT now() AS now`);
    const dbNow = new Date(rows[0]!.now);
    const cutoff = dailyCutoff(dbNow, timeZone, MEDIA_SYNC_HOUR);

    const { rows: settingsRows } = await tx.execute<{ media_sync_at: string | null }>(sql`SELECT media_sync_at FROM nod_settings WHERE id = 1 FOR UPDATE`);
    const lastAt = settingsRows[0]?.media_sync_at ? new Date(settingsRows[0].media_sync_at) : null;
    if (lastAt && lastAt.getTime() >= cutoff.getTime()) return false;

    await tx.update(nodSettings).set({ mediaSyncAt: dbNow, updatedAt: sql`now()` }).where(eq(nodSettings.id, 1));
    return true;
  });
  if (!claimed) return { ran: false };

  const result = await runMediaSync(db, client);
  return { ran: true, result };
}

/** Same start/stop shape as `digest.ts`'s `startDigestLoop`: a once-a-minute no-op call until
 * the tenant's wall clock actually reaches {@link MEDIA_SYNC_HOUR} for a day not already run.
 * Errors are logged (`safeErrorLabel`: no bound values) and never thrown out of the loop. */
export function startMediaSyncLoop(opts: { db: Db; client: MediaHubClient; timeZone: string; intervalMs?: number }): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = runMediaSyncIfDue(opts.db, opts.client, opts.timeZone)
      .catch((e) => console.error("[nod] media sync failed", safeErrorLabel(e)))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 60_000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

/** The sync status route's own read (`GET /api/media-hub/sync`): the feed cursor, the last run
 * time, and that run's recorded result (a {@link SyncResult}, or `{ error }` if it aborted). */
export async function getMediaSyncStatus(db: DbOrTx): Promise<{ since: string | null; at: string | null; result: unknown }> {
  const [row] = await db
    .select({ since: nodSettings.mediaSyncSince, at: nodSettings.mediaSyncAt, result: nodSettings.mediaSyncResult })
    .from(nodSettings)
    .where(eq(nodSettings.id, 1));
  return {
    since: row?.since ? row.since.toISOString() : null,
    at: row?.at ? row.at.toISOString() : null,
    result: row?.result ?? null,
  };
}

export type ResolveOutcome = "resolved" | "not-found" | "ref-not-found" | "media-hub-unavailable";

/**
 * `POST /api/media-members/:subscriberId/resolve`: staff clearing a `needs_attention` flag by
 * hand. With no `emailRef`, just clears the flag. With one, re-fetches the contact (`get`, so
 * staff always acts on current Media Hub data, never a stale cached ref list), re-points
 * `media_hub_email_ref` at it, and applies the same update-or-flag rule `applyChosenEmail` uses
 * for the nightly sync (never merges or silently drops another subscriber's address -- review
 * focus #3) -- so a ref that still collides re-flags `email-taken` rather than pretending to
 * resolve it.
 */
export async function resolveMediaMember(
  db: Db,
  mediaHub: MediaHubClient | null,
  subscriberId: string,
  emailRef: string | undefined,
  actor: string,
): Promise<ResolveOutcome> {
  const [current] = await db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
  if (!current) return "not-found";

  if (emailRef === undefined) {
    await db.transaction(async (tx) => {
      const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, subscriberId)).for("update");
      if (!s) return;
      await tx.update(subscribers).set({ needsAttention: null, attentionAt: null }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-resolved", s.mediaHubEmailRef ?? "");
    });
    return "resolved";
  }

  if (!mediaHub) return "media-hub-unavailable";
  if (current.mediaHubContactId === null) return "ref-not-found";
  const contact = await mediaHub.get(current.mediaHubContactId);
  const email = contact && !contact.deletedAt ? contact.emails.find((e) => e.ref === emailRef) : undefined;
  if (!contact || contact.deletedAt || !email) return "ref-not-found";

  const newAddress = normaliseEmail(email.address);
  const oldAddress = normaliseEmail(current.email);
  const [a, b] = [oldAddress, newAddress].sort() as [string, string];

  await db.transaction(async (tx) => {
    await lockAddress(tx, a);
    if (b !== a) await lockAddress(tx, b);
    const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, subscriberId)).for("update");
    if (!s) return;

    if (newAddress === oldAddress) {
      await tx.update(subscribers).set({ mediaHubEmailRef: emailRef, needsAttention: null, attentionAt: null }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-resolved", emailRef);
      return;
    }

    const [existing] = await tx.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${newAddress}`).for("update");
    if (existing && existing.id !== s.id) {
      await tx.update(subscribers).set({ mediaHubEmailRef: emailRef, needsAttention: "email-taken", attentionAt: sql`now()` }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-flagged", emailRef);
      return;
    }

    await tx
      .update(subscribers)
      .set({ email: newAddress, mediaHubEmailRef: emailRef, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1`, needsAttention: null, attentionAt: null })
      .where(eq(subscribers.id, s.id));
    await writeHistory(tx, s.id, actor, "media-hub-email-changed", emailRef);
  });
  return "resolved";
}
