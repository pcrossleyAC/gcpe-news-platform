import type { Db } from "@gcpe/db-kit";
import type { EventHandler } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { SiteBuilder } from "./builder";
import { drainQueue } from "./drain";
import type { NewsApiClient } from "./news-api-client";
import type { PostIndex } from "./post-index";
import { enqueuePages, PRIORITY } from "./queue";
import { chromeChanged, enqueueSiteWrite, stateAndBanner, writeSiteState } from "./rebuild";
import { enqueueRebuildAll } from "./rebuild-all";
import type { PageOptions, SiteInfo } from "./render";
import type { SiteStorage } from "./storage";

export interface SyncDeps {
  db: Db;
  builder: SiteBuilder;
  index: PostIndex;
  newsApi: NewsApiClient;
  storage: SiteStorage;
  site: SiteInfo;
  test: boolean;
  /** Pages per run (SITE_REBUILD_BATCH). */
  batch: number;
  /** Reads the change feed into the queue (change-feed.ts); absent in tests that don't need it. */
  feed?: () => Promise<unknown>;
}

export interface SyncResult {
  rendered: number;
  deferred: number;
  remaining: number;
}

const livePriority = (pageId: string) => (pageId.startsWith("post:") ? PRIORITY.livePost : PRIORITY.liveAggregate);

/**
 * One serialised turn (per SiteStorage, like every other site write): queue the caller's pages,
 * decide the chrome (a home() failure rejects the turn), read the change feed, render a batch.
 */
export function syncSite(deps: SyncDeps, extra: { pages?: string[] } = {}): Promise<SyncResult> {
  return enqueueSiteWrite(deps.storage, async () => {
    const { granville } = await deps.newsApi.home();
    const { state, banner } = stateAndBanner(granville, deps.test, new Date());
    const pageOpts: PageOptions = { test: deps.test, banner };
    if (extra.pages?.length) await enqueuePages(deps.db, extra.pages.map((pageId) => ({ pageId, priority: livePriority(pageId) })));
    if (await chromeChanged(deps.storage, state, deps.site)) {
      await enqueueRebuildAll(deps.db, deps.builder);
      await writeSiteState(deps.storage, state, deps.site);
    }
    if (deps.feed) {
      try {
        await deps.feed();
      } catch (err) {
        console.error(`[public-site] change feed unavailable; draining what is queued ${safeErrorLabel(err)}`);
      }
    }
    return drainQueue({ db: deps.db, builder: deps.builder }, { budget: deps.batch, pageOpts });
  });
}

export function createRebuildHandler(deps: SyncDeps): EventHandler {
  return async (_tx, event) => {
    const { pages } = event.data as { pages: string[] };
    await syncSite(deps, { pages: Array.isArray(pages) ? pages.filter((p): p is string => typeof p === "string") : [] });
  };
}
