import { withAdvisoryLock, type Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { RunCache, SiteBuilder } from "./builder";
import { completePage, deferPage, dependentPriority, enqueuePages, nextBatch, queueDepth } from "./queue";
import type { PageOptions } from "./render";

const BATCH = 50;

/**
 * Two-int advisory key (the "gcpe" space db-kit's migration lock uses — see db.ts's
 * MIGRATION_LOCK, slot 1 — and the News API's own EMBED_TICK_LOCK, slot 5, in its own,
 * separate database). Slot 6 is this drain's own, in the public site's own database; nothing
 * else in this codebase takes a lock in that database, so there is no slot to avoid colliding
 * with here, but the numbering stays consistent with the rest of the "gcpe" space regardless.
 *
 * Why this can never deadlock against the change-feed sync (`syncChanges`, change-feed.ts) or
 * the event handler (`createRebuildHandler`/`syncSite`, sync.ts): `withAdvisoryLock` takes it
 * with `pg_try_advisory_lock` (never blocking) on its own dedicated connection, not any
 * connection a transaction is open on. A lock acquired by a non-blocking try can never be a
 * link in a wait-for cycle — this session either has it already or gives up immediately, so it
 * never sits blocked holding one resource while waiting on another. `syncChanges`'s own
 * transactions (cursor plus enqueue) and `drainQueue`'s per-page completion transactions still
 * take ordinary row locks exactly as before; this guard runs on its own connection throughout
 * and never touches those. Within one process, `syncSite`'s `enqueueSiteWrite` queue already
 * serialises every turn — a tick and the standalone loop sharing one `SyncDeps` never call
 * `drainQueue` concurrently there — but this lock is what actually protects the two scenarios
 * that queue can't reach: multiple standalone replicas sharing one database, or a caller that
 * runs a drain outside that in-process queue.
 */
export const DRAIN_LOCK = [0x67637065, 6] as const;

class DrainBusyError extends Error {}

export interface DrainResult {
  rendered: number;
  deferred: number;
  remaining: number;
  /** Another drain already held DRAIN_LOCK; this run rendered nothing and returned at once. */
  skipped?: boolean;
}

async function drainLocked(deps: { db: Db; builder: SiteBuilder }, opts: { budget: number; pageOpts: PageOptions }): Promise<DrainResult> {
  const run: RunCache = {};
  const failed: string[] = [];
  let rendered = 0;
  while (rendered + failed.length < opts.budget) {
    const batch = await nextBatch(deps.db, Math.min(BATCH, opts.budget - rendered - failed.length), failed);
    if (batch.length === 0) break;
    for (const item of batch) {
      try {
        // M1: the render (whose post-page branch writes `site_posts`), the dependent enqueue
        // and completing the queue row all share this one transaction, so a failure after
        // rendering rolls the index write back too — the retry this page gets on a later run
        // then recomputes dependents from the same `before` state as this attempt did, not a
        // half-applied one. `drainLocked`'s own loop is sequential (no concurrent items), so
        // this doesn't reproduce I1: at most one of these transactions is ever open at once.
        await deps.db.transaction(async (tx) => {
          const dependents = await deps.builder.renderPage(item.pageId, opts.pageOpts, run, tx);
          if (dependents.length) await enqueuePages(tx, dependents.map((pageId) => ({ pageId, priority: dependentPriority(item.priority) })));
          await completePage(tx, item);
        });
        rendered++;
      } catch (err) {
        failed.push(item.pageId);
        console.error(`[public-site] rebuild of ${item.pageId} failed (attempt ${item.attempts + 1}); queued again ${safeErrorLabel(err)}`);
        await deferPage(deps.db, item);
      }
    }
  }
  return { rendered, deferred: failed.length, remaining: await queueDepth(deps.db) };
}

/**
 * spec §6.2: render up to `budget` queued pages, lowest priority first. Never throws for a
 * page. Guarded by DRAIN_LOCK (`pg_try_advisory_lock`, never blocking): an overlapping call
 * finds the lock held and returns `skipped: true` immediately, before reading the queue or
 * rendering anything — it is not an error and never logs a line (see DRAIN_LOCK's doc comment
 * for why this can't deadlock).
 */
export async function drainQueue(deps: { db: Db; builder: SiteBuilder }, opts: { budget: number; pageOpts: PageOptions }): Promise<DrainResult> {
  try {
    return await withAdvisoryLock(deps.db, DRAIN_LOCK, () => new DrainBusyError(), () => drainLocked(deps, opts));
  } catch (err) {
    if (err instanceof DrainBusyError) return { rendered: 0, deferred: 0, remaining: await queueDepth(deps.db), skipped: true };
    throw err;
  }
}
