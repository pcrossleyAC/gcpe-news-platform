import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { RunCache, SiteBuilder } from "./builder";
import { completePage, deferPage, dependentPriority, enqueuePages, nextBatch, queueDepth } from "./queue";
import type { PageOptions } from "./render";

const BATCH = 50;

/** spec §6.2: render up to `budget` queued pages, lowest priority first. Never throws for a page. */
export async function drainQueue(deps: { db: Db; builder: SiteBuilder }, opts: { budget: number; pageOpts: PageOptions }): Promise<{ rendered: number; deferred: number; remaining: number }> {
  const run: RunCache = {};
  const failed: string[] = [];
  let rendered = 0;
  while (rendered + failed.length < opts.budget) {
    const batch = await nextBatch(deps.db, Math.min(BATCH, opts.budget - rendered - failed.length), failed);
    if (batch.length === 0) break;
    for (const item of batch) {
      try {
        const dependents = await deps.builder.renderPage(item.pageId, opts.pageOpts, run);
        await deps.db.transaction(async (tx) => {
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
