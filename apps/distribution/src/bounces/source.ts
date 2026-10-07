import { asc, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { bounceInbox } from "../db/schema";

/**
 * Global Constraints "Bounce source": the one shape both the fake inbox and the Graph reader
 * implement, and the one shape bounces/run.ts depends on. The source is polled, not drained --
 * `fetchNew` never removes anything on its own; a caller that wants a fetched report not
 * fetched again calls `markProcessed` with its id afterward.
 */
export interface BounceSource {
  fetchNew(limit: number): Promise<{ id: string; raw: string }[]>;
  markProcessed(ids: string[]): Promise<void>;
}

/**
 * BOUNCE_SOURCE=fake (the default): a plain table fed by the Distribution.Operate-gated
 * `POST /api/bounces/inbox` route (http/routes.ts) -- used on test sites and in tests instead
 * of a real mailbox. Rows are returned oldest-received first, as Graph's own unread listing
 * effectively is (both are read in arrival order).
 */
export function fakeBounceSource(db: Db): BounceSource {
  return {
    async fetchNew(limit) {
      return db
        .select({ id: bounceInbox.id, raw: bounceInbox.raw })
        .from(bounceInbox)
        .where(isNull(bounceInbox.processedAt))
        .orderBy(asc(bounceInbox.receivedAt))
        .limit(limit);
    },
    async markProcessed(ids) {
      if (ids.length === 0) return;
      await db.update(bounceInbox).set({ processedAt: sql`now()` }).where(inArray(bounceInbox.id, ids));
    },
  };
}
