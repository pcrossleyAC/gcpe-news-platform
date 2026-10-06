import { eq, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import { replaceCancelledJob } from "./as-it-happens";
import { items, sendJobs } from "./db/schema";
import { itemCategories, renderMedia, type RenderOptions } from "./render";

/**
 * Creates (and populates recipients/deliveries for) the media-list send job for `itemKey`, if
 * one doesn't already exist. Mirrors `as-it-happens.ts`'s `createItemSend` (same job-key
 * scheme, same cancelled-job replacement, same "no recipients -> delete the job" rule), with
 * the recipient set itself being media list membership, not a public subscription match.
 *
 * Skipped (returns false without creating anything) for a withdrawn item, or one `itemFromRelease`
 * never filled media fields for (`mediaText` null or `mediaListKeys` empty -- i.e.
 * `publishFlags.toMediaLists` was false). Recipients are distinct `active` subscribers with a
 * subscription in an *active* list among the item's `mediaListKeys` (carried note: unlike
 * `listMediaLists`'s member count, a send must never count a member of a deactivated list).
 */
export async function createMediaSend(tx: Tx, itemKey: string, render: RenderOptions): Promise<boolean> {
  const [item] = await tx.select().from(items).where(eq(items.key, itemKey));
  if (!item) return false;
  if (item.withdrawnAt !== null || item.mediaText === null || item.mediaListKeys.length === 0) return false;

  const jobKey = `media:${itemKey}`;
  await replaceCancelledJob(tx, jobKey);

  const categories = await itemCategories(tx, item.listKeys);
  const rendered = renderMedia(
    { key: item.key, title: item.title, summary: item.summary, url: item.url, publishedAt: item.publishedAt, categories, mediaText: item.mediaText, postKind: item.postKind },
    render,
  );

  // ON CONFLICT (job_key) DO NOTHING: any *other* existing status (pending/sent/failed) keeps
  // this a no-op, same as createItemSend -- only 'cancelled' was cleared away above.
  const createdJob = await tx
    .insert(sendJobs)
    .values({ jobKey, itemKey, kind: "media", priority: "media", subject: rendered.subject, html: rendered.html, text: rendered.text })
    .onConflictDoNothing({ target: sendJobs.jobKey })
    .returning({ id: sendJobs.id });
  if (createdJob.length === 0) return false;
  const jobId = createdJob[0]!.id;

  // Set-based INSERT...SELECT (same reasoning as createItemSend): distinct active subscribers
  // whose subscription list key is one of the item's media list keys, in a list that's itself
  // still active -- a member of a list staff has since deactivated gets nothing.
  const inserted = await tx.execute(sql`
    INSERT INTO deliveries (item_key, subscriber_id, mode, job_id)
    SELECT DISTINCT ${itemKey}, s.id, 'media', ${jobId}::uuid
      FROM subscribers s
      JOIN subscriptions sub ON sub.subscriber_id = s.id
      JOIN lists l ON l.list_key = sub.list_key
     WHERE s.status = 'active'
       AND l.active = true
       AND sub.list_key = ANY(${sql.param(item.mediaListKeys)}::text[])
    ON CONFLICT DO NOTHING
    RETURNING 1
  `);

  // No matching recipient: an empty job would send nothing, so undo it rather than leave a
  // dead job behind.
  if (inserted.rows.length === 0) {
    await tx.delete(sendJobs).where(eq(sendJobs.id, jobId));
    return false;
  }

  // Derived from deliveries itself, never re-run from the subscriber/subscription match, so
  // job_recipients can never disagree with deliveries.
  await tx.execute(sql`
    INSERT INTO job_recipients (job_id, subscriber_id)
    SELECT job_id, subscriber_id FROM deliveries
     WHERE item_key = ${itemKey} AND mode = 'media' AND job_id = ${jobId}::uuid
    ON CONFLICT DO NOTHING
  `);
  return true;
}
