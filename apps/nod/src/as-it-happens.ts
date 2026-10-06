import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { deliveries, items, jobRecipients, sendJobs } from "./db/schema";
import { matchesItem } from "./matching";
import { itemCategories, renderAsItHappens, renderEmergency, type RenderItem, type RenderOptions } from "./render";

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
  /** Records a new emergency item (idempotent on `guid`) and, when it's genuinely new, sends it
   * in the same transaction. */
  recordEmergencyItem(db: Db, input: { guid: string; title: string; summary: string; url: string; publishedAt?: string }): Promise<{ key: string; created: boolean }>;
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

    // Controller ruling (carried from Task 2): a job for this key already exists but was
    // cancelled — the sender cancelled a claimed job of a withdrawn item, and the release has
    // since been republished. Treated like withdrawItem: delete that job's not-yet-attempted
    // deliveries and the job itself (job_recipients cascades), then fall through to create a
    // fresh job below. A delivery already attempted stays (its (item, subscriber, mode) primary
    // key then keeps that subscriber out of the fresh job's own insert).
    const [existing] = await tx.select({ id: sendJobs.id, status: sendJobs.status }).from(sendJobs).where(eq(sendJobs.jobKey, jobKey));
    if (existing?.status === "cancelled") {
      await tx.delete(deliveries).where(and(eq(deliveries.jobId, existing.id), isNull(deliveries.attemptedAt)));
      await tx.delete(sendJobs).where(eq(sendJobs.id, existing.id));
    }

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
    // list keys, excluding anyone who already has a digest delivery for this item. Emergency:
    // every active subscriber matching the item's list keys, whatever their own timing
    // preference (global constraints: As-It-Happens/emergency recipients).
    const timingCondition =
      kind === "as_it_happens"
        ? sql`s.as_it_happens = true AND NOT EXISTS (SELECT 1 FROM deliveries d2 WHERE d2.item_key = ${itemKey} AND d2.subscriber_id = s.id AND d2.mode = 'digest')`
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
  ): Promise<{ key: string; created: boolean }> {
    // Deterministic from the guid, so a repeat of the same guid always resolves to the same
    // item key — ON CONFLICT DO NOTHING below is then the whole idempotency story; no separate
    // guid column is needed.
    const key = `emergency:${createHash("sha256").update(input.guid).digest("hex").slice(0, 32)}`;
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
          publishedAt: input.publishedAt ? new Date(input.publishedAt) : sql`now()`,
          toSubscribers: true,
        })
        .onConflictDoNothing({ target: items.key })
        .returning({ key: items.key });
      const created = insertedRows.length > 0;
      if (created) await createItemSend(tx, key, "emergency");
      return { key, created };
    });
  }

  return { createItemSend, recordEmergencyItem };
}
