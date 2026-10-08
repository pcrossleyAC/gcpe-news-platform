import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { deliveries, items, sendJobs } from "./db/schema";
import { matchesItem } from "./matching";
import { itemCategories, renderAsItHappens, renderEmergency, type RenderItem, type RenderOptions } from "./render";
import { normalizeLinkIdentity } from "./emergency/feed";

export interface AsItHappensOptions {
  /** Site URL and optional banner for every As-It-Happens/emergency email this sends. */
  render: RenderOptions;
}

type SendKind = "as_it_happens" | "emergency";

async function renderItem(db: DbOrTx, row: { key: string; title: string; summary: string; url: string; publishedAt: Date; listKeys: string[] }): Promise<RenderItem> {
  const categories = await itemCategories(db, row.listKeys);
  return { key: row.key, title: row.title, summary: row.summary, url: row.url, publishedAt: row.publishedAt, categories };
}

export interface ItemSending {
  /** Creates (and populates recipients/deliveries for) the send job for `itemKey`, if one
   * doesn't already exist. Returns whether a job was created with at least one recipient. */
  createItemSend(tx: Tx, itemKey: string, kind: SendKind): Promise<boolean>;
  /** Records a new emergency item (idempotent on `guid`) and, when it's genuinely new and
   * `send` isn't false, sends it in the same transaction. */
  recordEmergencyItem(
    db: Db,
    input: { guid: string; title: string; summary: string; url: string; publishedAt?: string },
    opts?: { send?: boolean },
  ): Promise<{ key: string; created: boolean }>;
}

/** An emergency alert's `items.key`: deterministic from the feed's identity, so the feed
 * ingester, the admin route and the legacy importer all land on the same row for one alert. */
export function emergencyItemKey(identity: string): string {
  return `emergency:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

/**
 * Handles the case where a job for `jobKey` already exists but was
 * cancelled — the sender cancelled a claimed job of a withdrawn item, and the release has
 * since been republished. Deletes that job's not-yet-attempted deliveries and the job itself
 * (`job_recipients` cascades), clearing the way for the caller to insert a fresh job with the
 * same `job_key` right after. A delivery already attempted stays (its (item, subscriber, mode)
 * primary key then keeps that subscriber out of the fresh job's own insert). Any *other*
 * existing status (pending/sent/failed) is left untouched — the caller's own
 * `ON CONFLICT (job_key) DO NOTHING` insert then keeps it a no-op, same as always. Shared by
 * `createItemSend` (above) and `createMediaSend` (media-send.ts) — both key their jobs the same
 * way and must replace a cancelled job identically.
 */
export async function replaceCancelledJob(tx: Tx, jobKey: string): Promise<void> {
  const [existing] = await tx.select({ id: sendJobs.id, status: sendJobs.status }).from(sendJobs).where(eq(sendJobs.jobKey, jobKey));
  if (existing?.status === "cancelled") {
    await tx.delete(deliveries).where(and(eq(deliveries.jobId, existing.id), isNull(deliveries.attemptedAt)));
    await tx.delete(sendJobs).where(eq(sendJobs.id, existing.id));
  }
}

/**
 * Builds the two entry points As-It-Happens/emergency sending needs, closed over the render
 * options (siteUrl/bannerUrl) every email built here carries.
 */
export function createItemSending(opts: AsItHappensOptions): ItemSending {
  async function createItemSend(tx: Tx, itemKey: string, kind: SendKind): Promise<boolean> {
    const [item] = await tx.select().from(items).where(eq(items.key, itemKey));
    if (!item) return false;
    // Rule: an As-It-Happens send is skipped for a withdrawn item or one not flagged for
    // subscribers at all. Emergency items are always sent (recordEmergencyItem creates and
    // sends an emergency item in the same transaction, before either could apply to it).
    if (kind === "as_it_happens" && (item.withdrawnAt !== null || !item.toSubscribers)) return false;

    const jobKey = `${kind}:${itemKey}`;
    await replaceCancelledJob(tx, jobKey);

    const rItem = await renderItem(tx, item);
    const rendered = kind === "emergency" ? renderEmergency(rItem, opts.render) : renderAsItHappens(rItem, opts.render);

    // ON CONFLICT (job_key) DO NOTHING: any *other* existing status (pending/sent/failed) keeps
    // this a no-op, same as before this ruling — only 'cancelled' is cleared away above.
    const createdJob = await tx
      .insert(sendJobs)
      .values({ jobKey, itemKey, kind, subject: rendered.subject, html: rendered.html, text: rendered.text })
      .onConflictDoNothing({ target: sendJobs.jobKey })
      .returning({ id: sendJobs.id });
    if (createdJob.length === 0) return false;
    const jobId = createdJob[0]!.id;

    // As-It-Happens: active subscribers whose own as_it_happens is true, matching the item's
    // list keys, excluding anyone who already has a digest *or media* delivery for this item --
    // a media-list member who also matches the release publicly gets only the one (media) copy,
    // never both. Emergency: every active subscriber matching the item's list keys, whatever
    // their own timing preference (global constraints: As-It-Happens/emergency recipients).
    const timingCondition =
      kind === "as_it_happens"
        ? sql`s.as_it_happens = true AND NOT EXISTS (SELECT 1 FROM deliveries d2 WHERE d2.item_key = ${itemKey} AND d2.subscriber_id = s.id AND d2.mode IN ('digest', 'media'))`
        : sql`true`;

    // I1-style set-based INSERT...SELECT, entirely server-side — no JS round trip of matched
    // subscriber ids (same reasoning as the old createAsItHappensHandler this replaces).
    const inserted = await tx.execute(sql`
      INSERT INTO deliveries (item_key, subscriber_id, mode, job_id)
      SELECT DISTINCT ${itemKey}, s.id, 'as_it_happens', ${jobId}::uuid
        FROM subscribers s
        JOIN subscriptions sub ON sub.subscriber_id = s.id
       WHERE s.status = 'active'
         AND ${timingCondition}
         AND ${matchesItem(sql`sub.list_key`, sql`${sql.param(item.listKeys)}::text[]`)}
      ON CONFLICT DO NOTHING
      RETURNING 1
    `);

    // No matching recipient: an empty job would send nothing, so undo it rather than leave a
    // dead job behind.
    if (inserted.rows.length === 0) {
      await tx.delete(sendJobs).where(eq(sendJobs.id, jobId));
      return false;
    }

    // Derived from deliveries itself — not a third re-run of the subscriber/subscription match
    // — so job_recipients can never disagree with deliveries (same reasoning as the handler
    // this replaces).
    await tx.execute(sql`
      INSERT INTO job_recipients (job_id, subscriber_id)
      SELECT job_id, subscriber_id FROM deliveries
       WHERE item_key = ${itemKey} AND mode = 'as_it_happens' AND job_id = ${jobId}::uuid
      ON CONFLICT DO NOTHING
    `);
    return true;
  }

  async function recordEmergencyItem(
    db: Db,
    input: { guid: string; title: string; summary: string; url: string; publishedAt?: string },
    opts: { send?: boolean } = {},
  ): Promise<{ key: string; created: boolean }> {
    const key = emergencyItemKey(input.guid);
    return db.transaction(async (tx) => {
      const insertedRows = await tx
        .insert(items)
        .values({
          key,
          kind: "emergency",
          listKeys: ["emergency:alerts"],
          title: input.title,
          summary: input.summary,
          url: input.url,
          linkIdentity: normalizeLinkIdentity(input.url),
          publishedAt: input.publishedAt ? new Date(input.publishedAt) : sql`now()`,
          toSubscribers: true,
        })
        .onConflictDoNothing({ target: items.key })
        .returning({ key: items.key });
      const created = insertedRows.length > 0;
      if (created && opts.send !== false) await createItemSend(tx, key, "emergency");
      return { key, created };
    });
  }

  return { createItemSend, recordEmergencyItem };
}
