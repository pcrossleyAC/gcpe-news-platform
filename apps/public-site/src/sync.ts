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
  /** Another drain (another replica, or the tick and the standalone loop overlapping) already
   * held drain.ts's DRAIN_LOCK; this turn rendered nothing. */
  skipped?: boolean;
}

const livePriority = (pageId: string) => (pageId.startsWith("post:") ? PRIORITY.livePost : PRIORITY.liveAggregate);

/**
 * Single-flights `deps.feed()`: a storm of `site.rebuild_requested` events (each its own
 * `syncSite` call) shares one in-flight change-feed read instead of one each — concurrent
 * callers all get the same in-flight promise rather than each starting a fresh one. If any
 * arrived while it was running, exactly one follow-up run starts the moment it settles, so
 * whatever they were hoping to catch up on still gets read, just not once per caller.
 *
 * Called *before* `enqueueSiteWrite`'s per-`SiteStorage` turn queue below, not inside it: the
 * feed only touches the database (`syncChanges`'s own atomic cursor+enqueue transactions), not
 * `SiteStorage`, so it doesn't need that queue's serialisation — and staying outside it is what
 * lets genuinely concurrent callers actually overlap here instead of running one fully-finished
 * turn at a time, which would leave nothing left to coalesce.
 *
 * Keyed on the `feed` function reference itself (a `WeakMap`, like `enqueueSiteWrite`'s own
 * `siteWriteQueues`) — there is exactly one `feed` per process (start.ts), so every real caller
 * shares one entry; a test's fresh `feed` function each time never shares state with another's.
 */
const feedFlights = new WeakMap<() => Promise<unknown>, { inFlight: Promise<unknown>; pending: boolean }>();

function singleFlightFeed(feed: () => Promise<unknown>): Promise<unknown> {
  const existing = feedFlights.get(feed);
  if (existing) {
    existing.pending = true;
    return existing.inFlight;
  }
  const state = { inFlight: undefined as unknown as Promise<unknown>, pending: false };
  const run = (): Promise<unknown> => {
    const p = feed().finally(() => {
      if (state.pending) {
        state.pending = false;
        state.inFlight = run();
      } else {
        feedFlights.delete(feed);
      }
    });
    // `syncSite` doesn't `await` this until its turn actually runs (deferred behind
    // `enqueueSiteWrite`'s queue), which can be several microtasks after `run()` returns — a
    // rejection here would otherwise sit with no attached handler in the meantime and trip
    // Node's unhandled-rejection warning before that `await` catches up to it. This no-op
    // `.catch` only marks it handled for that bookkeeping; it doesn't consume the rejection —
    // every real caller's own `await p`/`.catch()` on this same promise still rejects normally.
    p.catch(() => {});
    return p;
  };
  state.inFlight = run();
  feedFlights.set(feed, state);
  return state.inFlight;
}

/**
 * One serialised turn (per SiteStorage, like every other site write): queue the caller's pages,
 * decide the chrome (a home() failure rejects the turn), read the change feed, render a batch.
 */
export function syncSite(deps: SyncDeps, extra: { pages?: string[] } = {}): Promise<SyncResult> {
  const feedRead = deps.feed ? singleFlightFeed(deps.feed) : undefined;
  return enqueueSiteWrite(deps.storage, async () => {
    const { granville } = await deps.newsApi.home();
    const { state, banner } = stateAndBanner(granville, deps.test, new Date());
    const pageOpts: PageOptions = { test: deps.test, banner };
    if (extra.pages?.length) await enqueuePages(deps.db, extra.pages.map((pageId) => ({ pageId, priority: livePriority(pageId) })));
    if (await chromeChanged(deps.storage, state, deps.site)) {
      await enqueueRebuildAll(deps.db, deps.builder);
      await writeSiteState(deps.storage, state, deps.site);
    }
    if (feedRead) {
      try {
        await feedRead;
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
