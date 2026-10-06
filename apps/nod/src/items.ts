import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { indexKeysFor, type EventEnvelope, type EventHandler, type ReleaseRecord } from "@gcpe/events";
import { deliveries, items, sendJobs } from "./db/schema";

const ENGLISH_LANGUAGE_ID = 4105;

/**
 * Builds an `items` row from an NRMS release (spec: items are what NoD sends).
 * - Title: the English document's headline, else the first document's, else the release key
 *   (a release can arrive with no documents at all, or an English one with no headline).
 * - Summary (amendment 2026-10-05, from three more legacy samples): the release's own
 *   `summary` field (`r.summary ?? ""`) — legacy emails print the English release's Summary
 *   field (`ReleasePublisher.cs:60`), pre-filled from the body trimmed to 500 characters
 *   (`NewModel.cs:332`) and staff-editable; NRMS mirrors this (`releases/service.ts:348`). This
 *   corrects the Task 2 rule, which read the English document's subheadline instead — that
 *   field is never used for the summary.
 */
export function itemFromRelease(r: ReleaseRecord, publicSiteUrl: string): typeof items.$inferInsert {
  const englishDoc = r.documents.find((d) => d.languageId === ENGLISH_LANGUAGE_ID);
  const title = englishDoc?.headline || r.documents[0]?.headline || r.key;
  const summary = r.summary ?? "";
  const url = `${publicSiteUrl.replace(/\/$/, "")}/releases/${encodeURIComponent(r.key)}`;

  return {
    key: r.key,
    kind: "release",
    postKind: r.kind,
    listKeys: indexKeysFor(r),
    title,
    summary,
    url,
    publishedAt: new Date(r.publishDate),
    toSubscribers: r.publishFlags.toSubscribers,
  };
}

/**
 * `release.published`: upsert the item from the release, clearing any prior `withdrawn_at` —
 * a release can be unpublished and later republished, and the republished item must not stay
 * marked withdrawn.
 */
export async function upsertReleaseItem(tx: DbOrTx, r: ReleaseRecord, publicSiteUrl: string): Promise<void> {
  const row = itemFromRelease(r, publicSiteUrl);
  const { key, ...rest } = row;
  await tx
    .insert(items)
    .values(row)
    .onConflictDoUpdate({ target: items.key, set: { ...rest, withdrawnAt: null, updatedAt: sql`now()` } });
}

/**
 * `release.updated` (a correction, or the 3e importer's replay of every live release with
 * `notify: false`): refreshes an existing item's title, summary, list keys and URL only — it
 * must never create an item or touch `publishedAt`/`toSubscribers`/`withdrawnAt`, and it must
 * never send anything. Returns whether an item existed to refresh.
 */
export async function refreshReleaseItem(tx: DbOrTx, r: ReleaseRecord, publicSiteUrl: string): Promise<boolean> {
  const row = itemFromRelease(r, publicSiteUrl);
  const updated = await tx
    .update(items)
    .set({ title: row.title, summary: row.summary, listKeys: row.listKeys, url: row.url, updatedAt: sql`now()` })
    .where(eq(items.key, r.key))
    .returning({ key: items.key });
  return updated.length > 0;
}

/**
 * `release.unpublished`: marks the item withdrawn (so the digest and any future match excludes
 * it), then for each of the item's still-`pending` jobs deletes that job's not-yet-attempted
 * deliveries and the job itself (`job_recipients` cascades on the job's delete). A job already
 * `sent`/`failed`/`cancelled` is left untouched — withdrawing doesn't undo a send that already
 * happened.
 *
 * Deleting (not just cancelling) the pending job matters for a republish: `deliveries`' primary
 * key is (item_key, subscriber_id, mode), so a stale, not-yet-attempted delivery row left behind
 * would conflict with the fresh `INSERT ... ON CONFLICT DO NOTHING` the As-It-Happens handler
 * runs on republish and silently swallow that subscriber forever — the old job would stay
 * cancelled, nobody ever re-sending to it. Deleting the row (not just cancelling the job) clears
 * the way for a brand-new job with fresh deliveries on republish. A delivery that was already
 * *attempted* (handed to Distribution before the unpublish) is kept — that email already went
 * out and must not be re-sent by a later republish; `deliveries.job_id`'s `ON DELETE SET NULL`
 * detaches it from the now-gone job instead of deleting it too.
 *
 * Fix round 2: a job the sender has currently claimed (`locked_until` in the future, status
 * still `pending` -- the lock-guarded terminal `sent`/`failed` write hasn't happened yet, see
 * send-jobs.ts's `claimOneJob`) must NOT be swept up here, even though its status still reads
 * `pending`. The send may already be in flight at Distribution with no record of that yet
 * (Task 4 adds `attempted_at` writes at claim time) -- deleting it mid-flight would let a
 * republish create a fresh job and double-send to every recipient. Only an *unclaimed* pending
 * job (`locked_until` null or already expired, by the database clock) is safe to delete: a
 * claimed one is left alone so its in-flight send finishes, and a later republish finds that
 * same job (and its now-conflicting deliveries) still there and sends nothing new for it.
 */
export async function withdrawItem(tx: DbOrTx, key: string): Promise<void> {
  await tx.update(items).set({ withdrawnAt: sql`now()`, updatedAt: sql`now()` }).where(eq(items.key, key));

  const pendingJobs = await tx
    .select({ id: sendJobs.id })
    .from(sendJobs)
    .where(
      and(
        eq(sendJobs.itemKey, key),
        eq(sendJobs.status, "pending"),
        or(isNull(sendJobs.lockedUntil), lte(sendJobs.lockedUntil, sql`now()`)),
      ),
    );
  if (pendingJobs.length === 0) return;

  const jobIds = pendingJobs.map((j) => j.id);
  await tx.delete(deliveries).where(and(inArray(deliveries.jobId, jobIds), isNull(deliveries.attemptedAt)));
  await tx.delete(sendJobs).where(inArray(sendJobs.id, jobIds));
}

export interface ItemHandlerOptions {
  publicSiteUrl: string;
  /** Called after a `release.published` item is upserted — As-It-Happens send-selection
   * (apps/nod/src/as-it-happens.ts's `createItemSend`). The return value (whether a job was
   * created) isn't used here; typed loosely so any such function fits without an adapter. */
  onPublished: (tx: Tx, r: ReleaseRecord) => Promise<unknown>;
}

/**
 * Resolves NRMS's release events to the handler above. Returns `undefined` for anything not
 * from `nrms` (including every Core event `lists.ts`'s `listsHandler` owns) so the two
 * resolvers can be chained with `??` in app.ts.
 */
export function itemHandlers(opts: ItemHandlerOptions): (e: EventEnvelope) => EventHandler | undefined {
  const onReleasePublished: EventHandler = async (tx, event) => {
    const r = event.data as ReleaseRecord;
    await upsertReleaseItem(tx, r, opts.publicSiteUrl);
    await opts.onPublished(tx, r);
  };
  const onReleaseUpdated: EventHandler = async (tx, event) => {
    await refreshReleaseItem(tx, event.data as ReleaseRecord, opts.publicSiteUrl);
  };
  const onReleaseUnpublished: EventHandler = async (tx, event) => {
    const { key } = event.data as { key: string };
    await withdrawItem(tx, key);
  };

  return (event: EventEnvelope): EventHandler | undefined => {
    if (event.source !== "nrms") return undefined;
    switch (event.type) {
      case "release.published":
        return onReleasePublished;
      case "release.updated":
        return onReleaseUpdated;
      case "release.unpublished":
        return onReleaseUnpublished;
      default:
        return undefined;
    }
  };
}
