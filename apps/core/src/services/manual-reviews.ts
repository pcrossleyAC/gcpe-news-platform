import { asc } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { manualReviews } from "../db/schema";

/*
 * Reviews of staff-manual page versions. Core never sees the manuals (they are compiled into the
 * Hub), so it cannot check that a page or hash exists: it keeps what a Core admin sends, shape-checked.
 * The Hub ignores rows whose page or hash it no longer has.
 */

/** Same rule as the manuals compiler's page ids: lower-case words joined by hyphens. */
export const manualReviewInputSchema = z
  .object({
    pageId: z.string().min(1).max(100).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ManualReviewInput = z.infer<typeof manualReviewInputSchema>;

export interface ManualReviewRecord {
  pageId: string;
  hash: string;
  reviewedBy: string;
  reviewedAt: string;
}

export async function listManualReviews(db: Db): Promise<ManualReviewRecord[]> {
  const rows = await db.select().from(manualReviews).orderBy(asc(manualReviews.reviewedAt), asc(manualReviews.pageId));
  return rows.map((r) => ({ pageId: r.pageId, hash: r.hash, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt.toISOString() }));
}

/** First review wins: a repeat for the same (page, version), by anyone, changes nothing. */
export async function recordManualReview(db: Db, input: ManualReviewInput, reviewedBy: string): Promise<void> {
  await db.insert(manualReviews).values({ pageId: input.pageId, hash: input.hash, reviewedBy }).onConflictDoNothing();
}
