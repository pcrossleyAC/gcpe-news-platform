/**
 * The nightly Media Hub sync (spec §5.3): pages through Media Hub's own changes feed and
 * reconciles each changed contact against whichever local subscribers point at it
 * (`subscribers.media_hub_contact_id`), flagging what it can't safely resolve on its own
 * (global constraints, "Members" / review focus #3) instead of ever merging or dropping data.
 *
 * A single run can span many pages (potentially the whole of Media Hub on the very first run,
 * `since = 1970`), so this never holds one open transaction for a whole run --
 * that would block `setPaused`/the digest/public journeys on the shared `nod_settings` row and
 * one address's advisory lock for as long as Media Hub takes to answer, and a single contact's
 * DB error (a unique-violation race, a deadlock victim) would abort everything fetched so far.
 * Instead, progress is tracked with a *lease*: `nod_settings.media_sync_lease` plus
 * `media_sync_lease_until` says who (if anyone) is actively working the feed right now, and
 * `media_sync_run_start`/`media_sync_cursor` carry a multi-tick run's position across
 * invocations. Each invocation bounds its own work (pages/time) and leaves the lease and
 * cursor for the next call -- scheduled tick or manual trigger -- to pick back up. No
 * transaction is ever held across a call to `client.changes()` or across more than one
 * subscriber's own update.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { dailyCutoff } from "../digest";
import { MEDIA_CATEGORY } from "../lists";
import { lockAddress, withLockedSubscriber } from "../locks";
import { removeMediaMember, hasMediaMemberships } from "../media-members";
import { writeHistory } from "../subscribe/history";
import { emailAddressSchema, normaliseEmail } from "../subscribe/info";
import { expireSessionLinks } from "../subscribe/links";
import { safeErrorLabel } from "../subscribe/journeys";
import { nodSettings, subscribers, subscriptions, type SubscriberRow } from "../db/schema";
import { MediaHubError, type MediaHubClient } from "./client";
import type { MediaHubContact } from "./contract";

/** Once per BC day at or after this local hour -- well clear of the nightly digest (17:00) and
 * any other scheduled job, same "computed like digestCutoff" shape (global constraints: clocks). */
export const MEDIA_SYNC_HOUR = 2;

/** How long a claimed lease is good for without being renewed -- long enough that a crashed
 * worker's abandoned run is noticed and taken over within a bounded time, short enough that a
 * stuck process doesn't block the feed indefinitely. */
const LEASE_MS = 15 * 60_000;

export interface SyncResult {
  /** Changed contacts seen across the whole feed this run. */
  contacts: number;
  /** Subscribers whose email address moved to the contact's new chosen address. */
  updated: number;
  /** Subscribers newly flagged `needs_attention` this run (a collision or a vanished ref). */
  flagged: number;
  /** Subscribers whose memberships were removed because their contact was deleted. */
  removed: number;
  /** Contacts or subscribers whose own processing failed and was skipped -- logged, never
   * fatal to the run. */
  errors: number;
}

/** What a stopped-without-finishing run (an error, or hitting its own bound) records: either
 * the normal counts (possibly partial -- see `inProgress` below) or an abort reason. */
export type StoredSyncResult = (SyncResult & { inProgress?: true }) | { error: string; kind?: string };

function zeroResult(): SyncResult {
  return { contacts: 0, updated: 0, flagged: 0, removed: 0, errors: 0 };
}

function isInProgress(value: unknown): value is SyncResult & { inProgress: true } {
  return !!value && typeof value === "object" && (value as { inProgress?: unknown }).inProgress === true;
}

const SYNC_ACTOR = "media-hub-sync";

type EmailOutcome = "updated" | "email-taken" | "email-gone" | "email-invalid" | "unchanged" | "cleared";

/**
 * Reconciles one subscriber's chosen Media Hub email against `contact`'s current emails (the
 * brief's "Feed" rules): the chosen ref's address moved (update, if free and a valid email,
 * else flag `email-taken`/`email-invalid`), the chosen ref vanished (flag `email-gone`, keep the
 * member -- C59), or nothing changed (clearing a stale flag if the ref came back valid).
 *
 * Media Hub's own contract doesn't require `.email()` on `address` (media-hub/contract.ts), so
 * a changed address is validated here, with the same schema the routes use, before it's ever
 * written to `subscribers.email` -- an invalid one is flagged `email-invalid` instead, leaving
 * the subscriber's current (still-valid) address untouched.
 *
 * Runs in its own short transaction: locks the per-address advisory lock(s) implied by
 * `snapshot` (sorted, old and new, so this can never deadlock against a concurrent
 * journeys/media-members lock taken in the other order), re-reads the subscriber row `FOR
 * UPDATE`, and -- since `snapshot` may be stale by the time this runs -- re-checks that the
 * freshly-locked row's email and chosen ref still match what `snapshot` was read with. A
 * mismatch (someone else changed this subscriber between the page read and now) returns
 * `"stale"` rather than acting on outdated information; the caller counts that as an error and
 * leaves it for the next run, which will see the subscriber's current state.
 */
async function applyChosenEmailSafely(db: Db, snapshot: SubscriberRow, contact: MediaHubContact, actor: string): Promise<EmailOutcome | "stale"> {
  const chosenRef = snapshot.mediaHubEmailRef;
  const email = chosenRef ? contact.emails.find((e) => e.ref === chosenRef) : undefined;
  const oldAddress = normaliseEmail(snapshot.email);
  const newAddress = email ? normaliseEmail(email.address) : null;
  const addresses = newAddress && newAddress !== oldAddress ? ([oldAddress, newAddress].sort() as [string, string]) : [oldAddress];

  return db.transaction(async (tx) => {
    for (const addr of addresses) await lockAddress(tx, addr);
    const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, snapshot.id)).for("update");
    if (!s) return "stale";
    if (normaliseEmail(s.email) !== oldAddress || s.mediaHubEmailRef !== chosenRef) return "stale";

    if (!email) {
      if (s.needsAttention === "email-gone") return "unchanged";
      await tx.update(subscribers).set({ needsAttention: "email-gone", attentionAt: sql`now()` }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-flagged", chosenRef ?? "");
      return "email-gone";
    }

    if (newAddress === oldAddress) {
      if (s.needsAttention !== "email-gone") return "unchanged";
      await tx.update(subscribers).set({ needsAttention: null, attentionAt: null }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-resolved", chosenRef ?? "");
      return "cleared";
    }

    if (!emailAddressSchema.safeParse(newAddress).success) {
      if (s.needsAttention === "email-invalid") return "unchanged";
      await tx.update(subscribers).set({ needsAttention: "email-invalid", attentionAt: sql`now()` }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-flagged", chosenRef ?? "");
      return "email-invalid";
    }

    const [existing] = await tx.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${newAddress}`);
    if (existing && existing.id !== s.id) {
      if (s.needsAttention === "email-taken") return "unchanged";
      await tx.update(subscribers).set({ needsAttention: "email-taken", attentionAt: sql`now()` }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-flagged", chosenRef ?? "");
      return "email-taken";
    }

    await tx
      .update(subscribers)
      .set({ email: newAddress!, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1`, needsAttention: null, attentionAt: null })
      .where(eq(subscribers.id, s.id));
    // Links mailed to the old address stop working, as for a public or staff move.
    await expireSessionLinks(tx, s.id, null);
    await writeHistory(tx, s.id, actor, "media-hub-email-changed", chosenRef ?? "");
    return "updated";
  });
}

/**
 * Applies one changed contact to every local subscriber it affects (read with a plain,
 * unlocked `select` -- no transaction spans this), folding each subscriber's outcome into
 * `result`. One subscriber's own failure -- a thrown error from its own short transaction (a
 * unique-violation race, a deadlock victim, anything) -- is caught here, counted in
 * `result.errors`, and logged (`safeErrorLabel`, contact id only -- never an address, global
 * constraints "Logs"); it never stops the rest of this contact's subscribers, let alone the
 * run. A feed-level {@link MediaHubError} from the caller's own `changes()` call is not caught
 * here.
 */
async function applyContact(db: Db, contact: MediaHubContact, result: SyncResult): Promise<void> {
  const rows = await db.select().from(subscribers).where(eq(subscribers.mediaHubContactId, contact.id));
  for (const snapshot of rows) {
    try {
      if (!(await hasMediaMemberships(db, snapshot.id))) continue;

      if (contact.deletedAt) {
        // `subscriptions.listKey` is already the full `<category>:<key>` -- removeMediaMember
        // takes the bare key and applies that prefix itself (mediaListKey), so it's stripped
        // back off here.
        const keys = await db
          .select({ listKey: subscriptions.listKey })
          .from(subscriptions)
          .where(sql`${subscriptions.subscriberId} = ${snapshot.id} AND ${subscriptions.listKey} LIKE ${`${MEDIA_CATEGORY}:%`}`);
        for (const { listKey } of keys) {
          await removeMediaMember(db, listKey.slice(MEDIA_CATEGORY.length + 1), snapshot.id, SYNC_ACTOR);
        }
        result.removed += 1;
        continue;
      }

      const outcome = await applyChosenEmailSafely(db, snapshot, contact, SYNC_ACTOR);
      if (outcome === "stale") {
        result.errors += 1;
        console.error("[nod] media sync: subscriber changed under us, skipped", contact.id);
      } else if (outcome === "updated") {
        result.updated += 1;
      } else if (outcome === "email-taken" || outcome === "email-gone" || outcome === "email-invalid") {
        result.flagged += 1;
      }
    } catch (e) {
      result.errors += 1;
      console.error("[nod] media sync: contact failed", contact.id, safeErrorLabel(e));
    }
  }
}

const EPOCH = new Date("1970-01-01T00:00:00Z");

type ClaimResult =
  | { kind: "busy" }
  | { kind: "not-due" }
  | { kind: "claimed"; lease: string; since: Date; cursor: string | null; runStart: Date; partial: SyncResult };

/**
 * Claims (or resumes) the right to work the feed, in one short transaction holding `SELECT ...
 * FROM nod_settings WHERE id = 1 FOR UPDATE` only for the few statements below -- never across
 * a Media Hub call. An active lease (`lease_until` still in the future) means somebody else is
 * already working it: `"busy"`. An expired one (abandoned, e.g. a crashed worker) is taken
 * over with a fresh lease uuid, keeping `run_start` and `cursor` so the run resumes exactly
 * where it left off. With no lease at all, `checkDue` (only passed by `runMediaSyncIfDue`)
 * applies the usual once-a-day cutoff check before starting a fresh run.
 */
async function claimOrResume(db: Db, checkDue?: { timeZone: string }): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const { rows: nowRows } = await tx.execute<{ now: string }>(sql`SELECT now() AS now`);
    const dbNow = new Date(nowRows[0]!.now);

    const [row] = await tx
      .select({
        since: nodSettings.mediaSyncSince,
        at: nodSettings.mediaSyncAt,
        lease: nodSettings.mediaSyncLease,
        leaseUntil: nodSettings.mediaSyncLeaseUntil,
        runStart: nodSettings.mediaSyncRunStart,
        cursor: nodSettings.mediaSyncCursor,
        result: nodSettings.mediaSyncResult,
      })
      .from(nodSettings)
      .where(eq(nodSettings.id, 1))
      .for("update");

    const hasLease = row?.lease != null;
    const leaseActive = hasLease && row!.leaseUntil !== null && row!.leaseUntil.getTime() > dbNow.getTime();
    if (leaseActive) return { kind: "busy" };

    const partial: SyncResult = isInProgress(row?.result) ? { ...row!.result } : zeroResult();

    if (hasLease) {
      // Expired -- take it over. run_start and cursor (this run's own progress) are untouched.
      const lease = randomUUID();
      await tx
        .update(nodSettings)
        .set({ mediaSyncLease: lease, mediaSyncLeaseUntil: new Date(dbNow.getTime() + LEASE_MS), updatedAt: sql`now()` })
        .where(eq(nodSettings.id, 1));
      return { kind: "claimed", lease, since: row!.since ?? EPOCH, cursor: row!.cursor, runStart: row!.runStart ?? dbNow, partial };
    }

    if (checkDue) {
      const cutoff = dailyCutoff(dbNow, checkDue.timeZone, MEDIA_SYNC_HOUR);
      if (row?.at && row.at.getTime() >= cutoff.getTime()) return { kind: "not-due" };
    }

    // Starting fresh.
    const lease = randomUUID();
    await tx
      .update(nodSettings)
      .set({
        mediaSyncAt: dbNow,
        mediaSyncRunStart: dbNow,
        mediaSyncCursor: null,
        mediaSyncLease: lease,
        mediaSyncLeaseUntil: new Date(dbNow.getTime() + LEASE_MS),
        updatedAt: sql`now()`,
      })
      .where(eq(nodSettings.id, 1));
    return { kind: "claimed", lease, since: row?.since ?? EPOCH, cursor: null, runStart: dbNow, partial: zeroResult() };
  });
}

/** Extends the lease and saves progress between pages -- guarded by `lease` matching, so a
 * worker that's lost its lease (taken over as abandoned) notices and stops instead of
 * clobbering whoever has it now. */
async function saveProgress(db: Db, lease: string, cursor: string | null, result: SyncResult): Promise<boolean> {
  const rows = await db
    .update(nodSettings)
    .set({ mediaSyncCursor: cursor, mediaSyncLeaseUntil: sql`now() + interval '15 minutes'`, mediaSyncResult: { ...result, inProgress: true }, updatedAt: sql`now()` })
    .where(and(eq(nodSettings.id, 1), eq(nodSettings.mediaSyncLease, lease)))
    .returning({ id: nodSettings.id });
  return rows.length > 0;
}

/** Called when this invocation's own bound (pages or time) is reached before the feed is fully
 * processed: saves the cursor like {@link saveProgress}, but -- unlike it -- expires the lease
 * immediately (`lease_until = now()`) rather than renewing it, so the very next caller (the
 * next scheduled tick, or a manual trigger) finds it already expired and resumes right away
 * instead of waiting out the full 15-minute lease window. */
async function pauseRun(db: Db, lease: string, cursor: string | null, result: SyncResult): Promise<boolean> {
  const rows = await db
    .update(nodSettings)
    .set({ mediaSyncCursor: cursor, mediaSyncLeaseUntil: sql`now()`, mediaSyncResult: { ...result, inProgress: true }, updatedAt: sql`now()` })
    .where(and(eq(nodSettings.id, 1), eq(nodSettings.mediaSyncLease, lease)))
    .returning({ id: nodSettings.id });
  return rows.length > 0;
}

/** Called once the whole feed (every page back to a `null` `nextCursor`) has been processed:
 * advances `media_sync_since` to this run's own start instant (captured before paging began,
 * so a contact that changes mid-run is still picked up next time), records the final result,
 * and clears the lease and this run's progress fields. */
async function finishRun(db: Db, lease: string, runStart: Date, result: SyncResult): Promise<boolean> {
  const rows = await db
    .update(nodSettings)
    .set({
      mediaSyncSince: runStart,
      mediaSyncResult: result,
      mediaSyncCursor: null,
      mediaSyncRunStart: null,
      mediaSyncLease: null,
      mediaSyncLeaseUntil: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(nodSettings.id, 1), eq(nodSettings.mediaSyncLease, lease)))
    .returning({ id: nodSettings.id });
  return rows.length > 0;
}

export interface SyncBound {
  maxPages: number;
  maxMs: number;
}

/** The scheduled tick's own bound -- short enough that a sync in progress never meaningfully
 * delays the rest of the same tick (or the next one). */
export const SCHEDULED_BOUND: SyncBound = { maxPages: 5, maxMs: 20_000 };

/** The manual trigger's bound -- generous, since an operator waiting on the response would
 * rather it just finish (for any feed small enough to fit), but kept under the stack's proxy
 * timeout so a big feed still gets a response instead of a gateway timeout. */
export const MANUAL_BOUND: SyncBound = { maxPages: 30, maxMs: 30_000 };

export interface SyncOutcome {
  /** Whether the *whole* feed (back to the previous run's since) has now been processed, not
   * just this invocation's own bounded slice of it. */
  done: boolean;
  result: StoredSyncResult;
}

/**
 * Does the actual work for a claimed lease: pages through `client.changes(since, cursor)`,
 * applying every changed contact as it goes, with *no transaction open* across a page fetch or
 * across more than one subscriber's own update (see this module's own doc comment for why).
 * Stops and saves its position (never advancing `media_sync_since`) once `bound` is reached,
 * once the feed is exhausted (`nextCursor === null`, when `media_sync_since` *does* advance),
 * or on any thrown error -- a feed-level {@link MediaHubError} or anything else -- which is
 * recorded as `{ error, kind }` and clears the lease so the next call starts the retry (the
 * brief's "Errors": never advances `since`/`cursor` past the point already saved).
 */
async function runBounded(db: Db, client: MediaHubClient, claim: Extract<ClaimResult, { kind: "claimed" }>, bound: SyncBound): Promise<SyncOutcome> {
  const sinceIso = claim.since.toISOString();
  let cursor = claim.cursor;
  const result: SyncResult = { ...claim.partial };
  const startedAt = Date.now();
  let pages = 0;

  try {
    for (;;) {
      const page = await client.changes(sinceIso, cursor);
      for (const contact of page.contacts) {
        result.contacts += 1;
        await applyContact(db, contact, result);
      }
      cursor = page.nextCursor;
      pages += 1;

      if (cursor === null) {
        const finished = await finishRun(db, claim.lease, claim.runStart, result);
        return { done: finished, result };
      }

      if (pages >= bound.maxPages || Date.now() - startedAt >= bound.maxMs) {
        await pauseRun(db, claim.lease, cursor, result);
        return { done: false, result };
      }

      if (!(await saveProgress(db, claim.lease, cursor, result))) {
        // Lost the lease mid-run (someone else decided it was abandoned and took it over) --
        // stop quietly rather than keep working state that's no longer ours to report.
        return { done: false, result };
      }
    }
  } catch (e) {
    const errorResult: StoredSyncResult = { error: safeErrorLabel(e), kind: e instanceof MediaHubError ? e.kind : undefined };
    await db
      .update(nodSettings)
      .set({ mediaSyncLease: null, mediaSyncLeaseUntil: null, mediaSyncResult: errorResult, updatedAt: sql`now()` })
      .where(and(eq(nodSettings.id, 1), eq(nodSettings.mediaSyncLease, claim.lease)));
    return { done: false, result: errorResult };
  }
}

/**
 * Runs the sync now: claims the lease (no "is it due" check -- that's {@link runMediaSyncIfDue})
 * and works it for up to `bound` (default {@link MANUAL_BOUND}). Returns `"busy"` instead of a
 * result when another invocation already holds an active lease (the route maps this to 409).
 */
export async function runMediaSync(db: Db, client: MediaHubClient, bound: SyncBound = MANUAL_BOUND): Promise<SyncOutcome | "busy"> {
  const claim = await claimOrResume(db);
  if (claim.kind === "busy") return "busy";
  // claimOrResume only returns "not-due" when `checkDue` was passed, which this call never does.
  return runBounded(db, client, claim as Extract<ClaimResult, { kind: "claimed" }>, bound);
}

/**
 * Runs the sync if it's due: once per BC day at or after {@link MEDIA_SYNC_HOUR} (`dailyCutoff`,
 * the database's own `now()`, never Postgres's tzdata), and works it for up to `bound` (default
 * {@link SCHEDULED_BOUND}). An in-progress run (someone else's active lease) or a day already
 * run both report `ran: false`.
 */
export async function runMediaSyncIfDue(
  db: Db,
  client: MediaHubClient,
  timeZone: string,
  bound: SyncBound = SCHEDULED_BOUND,
): Promise<{ ran: boolean; done?: boolean; result?: StoredSyncResult }> {
  const claim = await claimOrResume(db, { timeZone });
  if (claim.kind !== "claimed") return { ran: false };
  const outcome = await runBounded(db, client, claim, bound);
  return { ran: true, done: outcome.done, result: outcome.result };
}

/** Same start/stop shape as `digest.ts`'s `startDigestLoop`: a once-a-minute no-op call until
 * the tenant's wall clock actually reaches {@link MEDIA_SYNC_HOUR} for a day not already run
 * (or, mid-run, the next bounded slice of an already-claimed one). Errors are logged
 * (`safeErrorLabel`: no bound values) and never thrown out of the loop. */
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
 * time, that run's recorded result, and whether a lease is currently active. */
export async function getMediaSyncStatus(db: DbOrTx): Promise<{ since: string | null; at: string | null; result: unknown; running: boolean }> {
  const [row] = await db
    .select({ since: nodSettings.mediaSyncSince, at: nodSettings.mediaSyncAt, result: nodSettings.mediaSyncResult, leaseUntil: nodSettings.mediaSyncLeaseUntil })
    .from(nodSettings)
    .where(eq(nodSettings.id, 1));
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  const dbNow = new Date(rows[0]!.now);
  return {
    since: row?.since ? row.since.toISOString() : null,
    at: row?.at ? row.at.toISOString() : null,
    result: row?.result ?? null,
    running: !!(row?.leaseUntil && row.leaseUntil.getTime() > dbNow.getTime()),
  };
}

export type ResolveOutcome = "resolved" | "not-found" | "ref-not-found" | "media-hub-unavailable" | "email-taken" | "invalid-email" | "conflict";

/**
 * `POST /api/media-members/:subscriberId/resolve`: staff clearing a `needs_attention` flag by
 * hand. With no `emailRef`, clears the flag under the address lock; clearing `bouncing` also
 * restarts the bounce window. With one, re-fetches the contact (`get`, so
 * staff always acts on current Media Hub data, never a stale cached ref list), re-points
 * `media_hub_email_ref` at it, and applies the same update-or-flag rule the sync uses (never
 * merges or silently drops another subscriber's address -- review focus #3): a ref that still
 * collides re-flags `email-taken` (the route 409s, it doesn't pretend to resolve). The address
 * used to decide lock order and the new one are both read before the `mediaHub.get` network
 * call (which must not happen while holding a lock); the locked re-read is checked against
 * that snapshot, and a mismatch (something else changed this subscriber meanwhile) returns
 * `"conflict"` rather than acting on stale data.
 *
 * The ref's address is validated against the same schema the routes use before anything else --
 * the contract (media-hub/contract.ts) doesn't require `.email()`, and this is a staff action
 * pointing the subscriber straight at it, so an invalid address is rejected outright
 * (`"invalid-email"`, the route maps it to 400) rather than written or flagged.
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
    // Clearing a flag is a write to the subscriber row, so it takes the address lock like every
    // other writer (locks.ts). Clearing "bouncing" means staff judge the mailbox fixed: the
    // bounce threshold restarts from now, as a staff reactivation does (C84), so the bounces
    // that caused the flag don't re-flag the member on the very next one.
    return withLockedSubscriber(db, subscriberId, null, async (tx, s): Promise<ResolveOutcome> => {
      if (!s) return "not-found";
      if (s.needsAttention === null) return "resolved";
      const bouncing = s.needsAttention === "bouncing";
      await tx
        .update(subscribers)
        .set({ needsAttention: null, attentionAt: null, ...(bouncing ? { bounceWindowFrom: sql`now()` } : {}) })
        .where(eq(subscribers.id, s.id));
      if (bouncing) await writeHistory(tx, s.id, actor, "bounce-resolved");
      else await writeHistory(tx, s.id, actor, "media-hub-resolved", s.mediaHubEmailRef ?? "");
      return "resolved";
    });
  }

  if (!mediaHub) return "media-hub-unavailable";
  if (current.mediaHubContactId === null) return "ref-not-found";
  const contact = await mediaHub.get(current.mediaHubContactId);
  const email = contact && !contact.deletedAt ? contact.emails.find((e) => e.ref === emailRef) : undefined;
  if (!contact || contact.deletedAt || !email) return "ref-not-found";
  if (!emailAddressSchema.safeParse(email.address).success) return "invalid-email";

  const newAddress = normaliseEmail(email.address);
  const oldAddress = normaliseEmail(current.email);
  const [a, b] = [oldAddress, newAddress].sort() as [string, string];

  return db.transaction(async (tx): Promise<ResolveOutcome> => {
    await lockAddress(tx, a);
    if (b !== a) await lockAddress(tx, b);
    const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, subscriberId)).for("update");
    if (!s) return "not-found";
    if (normaliseEmail(s.email) !== oldAddress) return "conflict";

    if (newAddress === oldAddress) {
      await tx.update(subscribers).set({ mediaHubEmailRef: emailRef, needsAttention: null, attentionAt: null }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-resolved", emailRef);
      return "resolved";
    }

    const [existing] = await tx.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${newAddress}`).for("update");
    if (existing && existing.id !== s.id) {
      await tx.update(subscribers).set({ mediaHubEmailRef: emailRef, needsAttention: "email-taken", attentionAt: sql`now()` }).where(eq(subscribers.id, s.id));
      await writeHistory(tx, s.id, actor, "media-hub-flagged", emailRef);
      return "email-taken";
    }

    await tx
      .update(subscribers)
      .set({ email: newAddress, mediaHubEmailRef: emailRef, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1`, needsAttention: null, attentionAt: null })
      .where(eq(subscribers.id, s.id));
    await expireSessionLinks(tx, s.id, null);
    await writeHistory(tx, s.id, actor, "media-hub-email-changed", emailRef);
    return "resolved";
  });
}
