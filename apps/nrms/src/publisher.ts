import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, type ReleaseRecord, type SubscriberConfig } from "@gcpe/events";
import { releases, type ReleaseRow } from "./db/schema";

export interface PublishOptions {
  db: Db;
  subscribers: SubscriberConfig[];
  now?: () => Date;
  limit?: number;
}

export function toReleaseRecord(row: ReleaseRow, publishedAt: Date): ReleaseRecord {
  const at = publishedAt.toISOString();
  return { ...row.content, key: row.key, kind: row.kind, publishDate: at, timestamp: at, atomId: null, renditions: null };
}

/**
 * Spec §5 step 4: one transaction per release — claim it with FOR UPDATE SKIP LOCKED (so
 * concurrent replicas never publish the same release), mark it published, and write
 * release.published to the outbox in that same transaction.
 */
export async function publishDue(opts: PublishOptions): Promise<{ published: string[] }> {
  const now = (opts.now ?? (() => new Date()))();
  const limit = opts.limit ?? 50;
  const published: string[] = [];
  while (published.length < limit) {
    const key = await opts.db.transaction(async (tx) => {
      const claimed = await tx.execute<{ key: string }>(sql`
        SELECT key FROM ${releases}
        WHERE status = 'scheduled' AND publish_at <= ${now.toISOString()}::timestamptz
        ORDER BY publish_at, key
        FOR UPDATE SKIP LOCKED LIMIT 1`);
      const k = claimed.rows[0]?.key;
      if (!k) return null;
      const [row] = await tx
        .update(releases)
        .set({ status: "published", publishedAt: now, updatedAt: now })
        .where(sql`${releases.key} = ${k}`)
        .returning();
      await enqueueEvent(tx, { type: "release.published", source: "nrms", aggregateId: row!.key, data: toReleaseRecord(row!, now) }, opts.subscribers);
      return row!.key;
    });
    if (!key) break;
    published.push(key);
  }
  return { published };
}

export function startPublisher(opts: PublishOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = publishDue(opts)
      .then((r) => r.published.length && console.log(`[nrms] published ${r.published.join(", ")}`))
      .catch((e) => console.error("[nrms] publish failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
