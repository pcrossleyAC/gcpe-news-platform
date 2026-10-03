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

const MAX_LAST_ERROR_LENGTH = 500;

/**
 * Spec §5 step 4: one transaction per release — claim it with FOR UPDATE SKIP LOCKED (so
 * concurrent replicas never publish the same release), mark it published, and write
 * release.published to the outbox in that same transaction.
 *
 * A release that fails after being claimed (e.g. EventTooLargeError or a ZodError out of
 * enqueueEvent/parseEvent) rolls that transaction back — the release reverts to 'scheduled'.
 * Left alone, the next loop iteration's ORDER BY publish_at, key would re-claim the exact
 * same release first and fail the same way forever, wedging every release behind it. So a
 * post-claim failure is caught here and the release is moved to 'failed' in a separate,
 * short update (guarded by status = 'scheduled' so it never clobbers a concurrent success),
 * and the loop continues to the next release. Only a failure during the claim query itself
 * (no key was ever claimed — e.g. the database is unreachable) propagates, since there is
 * nothing per-release to isolate it to.
 */
export async function publishDue(opts: PublishOptions): Promise<{ published: string[]; failed: string[] }> {
  const now = (opts.now ?? (() => new Date()))();
  const limit = opts.limit ?? 50;
  const published: string[] = [];
  const failed: string[] = [];
  while (published.length + failed.length < limit) {
    let claimedKey: string | null = null;
    let key: string | null;
    try {
      key = await opts.db.transaction(async (tx) => {
        const claimed = await tx.execute<{ key: string }>(sql`
          SELECT key FROM ${releases}
          WHERE status = 'scheduled' AND publish_at <= ${now.toISOString()}::timestamptz
          ORDER BY publish_at, key
          FOR UPDATE SKIP LOCKED LIMIT 1`);
        const k = claimed.rows[0]?.key;
        if (!k) return null;
        claimedKey = k;
        const [row] = await tx
          .update(releases)
          .set({ status: "published", publishedAt: now, updatedAt: now })
          .where(sql`${releases.key} = ${k}`)
          .returning();
        await enqueueEvent(tx, { type: "release.published", source: "nrms", aggregateId: row!.key, data: toReleaseRecord(row!, now) }, opts.subscribers);
        return row!.key;
      });
    } catch (e) {
      if (!claimedKey) throw e; // the claim itself failed (e.g. DB down) — nothing to isolate, propagate.
      const message = e instanceof Error ? e.message : String(e);
      const lastError = message.slice(0, MAX_LAST_ERROR_LENGTH);
      await opts.db
        .update(releases)
        .set({ status: "failed", lastError, updatedAt: now })
        .where(sql`${releases.key} = ${claimedKey} AND ${releases.status} = 'scheduled'`);
      console.error(`[nrms] publish failed for ${claimedKey}: ${message}`);
      failed.push(claimedKey);
      continue;
    }
    if (!key) break;
    published.push(key);
  }
  return { published, failed };
}

export function startPublisher(opts: PublishOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = publishDue(opts)
      .then((r) => {
        if (r.published.length) console.log(`[nrms] published ${r.published.join(", ")}`);
        if (r.failed.length) console.log(`[nrms] failed to publish ${r.failed.join(", ")}`);
      })
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
