import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { indexKeysFor, type EventEnvelope, type EventHandler, type ReleaseRecord } from "@gcpe/events";
import { items, sendJobs } from "./db/schema";

const ENGLISH_LANGUAGE_ID = 4105;

/**
 * Builds an `items` row from an NRMS release (spec: items are what NoD sends). Title and
 * summary each have their own fallback chain, read from the real legacy digest sample
 * (`docs/parity/samples/daily-digest-2026-09-22.md`):
 * - Title: the English document's headline, else the first document's, else the release key
 *   (a release can arrive with no documents at all, or an English one with no headline).
 * - Summary: the English document's subheadline — the line the legacy digest printed under
 *   each title — when it's non-empty, else `r.summary ?? ""`. Only the English document's
 *   subheadline counts here; there's no "first document" fallback for summary.
 */
export function itemFromRelease(r: ReleaseRecord, publicSiteUrl: string): typeof items.$inferInsert {
  const englishDoc = r.documents.find((d) => d.languageId === ENGLISH_LANGUAGE_ID);
  const title = englishDoc?.headline || r.documents[0]?.headline || r.key;
  const summary = englishDoc?.subheadline ? englishDoc.subheadline : r.summary ?? "";
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
 * it) and cancels its still-pending send jobs (so a sender that hasn't run yet skips it). A job
 * already sent or failed is left alone — withdrawing doesn't undo a send that already happened.
 */
export async function withdrawItem(tx: DbOrTx, key: string): Promise<void> {
  await tx.update(items).set({ withdrawnAt: sql`now()`, updatedAt: sql`now()` }).where(eq(items.key, key));
  await tx
    .update(sendJobs)
    .set({ status: "cancelled" })
    .where(and(eq(sendJobs.itemKey, key), eq(sendJobs.status, "pending")));
}

export interface ItemHandlerOptions {
  publicSiteUrl: string;
  /** Called after a `release.published` item is upserted. Interim As-It-Happens job creation
   * today (apps/nod/src/app.ts); Task 5 replaces it with the real send-selection logic. */
  onPublished: (tx: Tx, r: ReleaseRecord) => Promise<void>;
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
