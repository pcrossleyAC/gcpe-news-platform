import type { Db } from "@gcpe/db-kit";
import type { EventHandler } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { SiteSettings } from "@gcpe/site-settings";
import type { SiteBuilder } from "./builder";
import { drainQueue } from "./drain";
import type { NewsApiClient } from "./news-api-client";
import type { PostIndex } from "./post-index";
import { enqueuePages, PRIORITY } from "./queue";
import { chromeChanges, enqueueSiteWrite, keepSettingsHashes, stateAndBanner, writeSiteState, type SiteRenderState } from "./rebuild";
import { enqueueChromeChanges } from "./rebuild-all";
import type { PageOptions, SiteInfo } from "./render";
import { currentSettings, themeDefaults } from "./settings";
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
  /** The tenant's site settings defaults (`loadSiteSettingsDefaults`, start.ts): what the site
   * shows while nothing is published. Absent ⇒ derived from `site.theme`. */
  defaultSettings?: SiteSettings;
}

/**
 * This turn's render options and site-state: Blue Bridge from `home()` (a failure rejects), then
 * the site settings (settings.ts's currentSettings never rejects). `fallbackDefaults`: the
 * settings fetch failed with nothing persisted, so the defaults stand in for this render only.
 * Shared by `syncSite` and `selfHeal`.
 */
export async function turnOptions(deps: SyncDeps, granville: string | null): Promise<{ state: SiteRenderState; pageOpts: PageOptions; fallbackDefaults: boolean }> {
  const { settings, fallbackDefaults } = await currentSettings({ newsApi: deps.newsApi, storage: deps.storage, defaults: deps.defaultSettings ?? themeDefaults(deps.site.theme) });
  const { state, banner } = stateAndBanner(granville, deps.test, new Date(), settings, deps.site);
  return { state, pageOpts: { test: deps.test, banner, settings }, fallbackDefaults };
}

/**
 * Queues what the chrome or the settings changed since the marker, then moves the marker. A
 * settings fetch failure never delays a site-wide change (Blue Bridge, test, chrome version, base
 * URL): with a persisted document the turn proceeds normally; with only the stand-in defaults
 * (`fallbackDefaults`), the marker's settings hashes are kept, so the defaults neither queue a
 * settings rebuild nor get recorded as applied — everything else is compared and recorded.
 */
export async function applyChromeChanges(deps: SyncDeps, turn: { state: SiteRenderState; fallbackDefaults: boolean }, force = false): Promise<void> {
  const state = turn.fallbackDefaults ? await keepSettingsHashes(deps.storage, turn.state) : turn.state;
  const changes = force ? { all: true, sections: [] } : await chromeChanges(deps.storage, state, deps.site);
  if (!changes.all && changes.sections.length === 0) return;
  await enqueueChromeChanges(deps.db, deps.builder, changes);
  await writeSiteState(deps.storage, state, deps.site);
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
 * decide the chrome and the site settings (a home() failure rejects the turn; a settings failure
 * keeps the last applied), read the change feed, render a batch.
 */
export function syncSite(deps: SyncDeps, extra: { pages?: string[] } = {}): Promise<SyncResult> {
  const feedRead = deps.feed ? singleFlightFeed(deps.feed) : undefined;
  return enqueueSiteWrite(deps.storage, async () => {
    const { granville } = await deps.newsApi.home();
    const turn = await turnOptions(deps, granville);
    const { pageOpts } = turn;
    if (extra.pages?.length) await enqueuePages(deps.db, extra.pages.map((pageId) => ({ pageId, priority: livePriority(pageId) })));
    await applyChromeChanges(deps, turn);
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

/**
 * I1: the receiver's transaction holds a pool connection for as long as its handler runs, so the
 * handler here only does quick work — it enqueues the event's own pages at live priority, using
 * the receiver's own `tx` so the insert is atomic with the inbox row — then returns. It never
 * drains the queue, reads the change feed or calls the News API itself: a storm of concurrent
 * deliveries during a long drain used to each await a full `syncSite` turn from inside this
 * transaction, which could exhaust the pool (nine or so deliveries was enough) and wedge every
 * connection waiting on one that would never free up. The actual drain and feed read now happen
 * in the background, kicked (not awaited) once the transaction commits — see `onApplied` in
 * app.ts/start.ts and `kickBackgroundSync` below. The tick (`workers.sync`/the standalone loop)
 * is the backstop either way, so a live publish still renders within one or two ticks even if
 * the kicked run is still coalescing behind a backlog.
 */
export function createRebuildHandler(deps: SyncDeps): EventHandler {
  return async (tx, event) => {
    const { pages } = event.data as { pages: string[] };
    const pageIds = Array.isArray(pages) ? pages.filter((p): p is string => typeof p === "string") : [];
    if (pageIds.length) await enqueuePages(tx, pageIds.map((pageId) => ({ pageId, priority: livePriority(pageId) })));
  };
}

/**
 * Single-flights a background `syncSite` run per `deps`, the same way `singleFlightFeed` above
 * single-flights the feed read within one turn: one run in flight, at most one more queued
 * behind it for whoever asked while it was running. Called from the receiver's `onApplied`
 * (app.ts/start.ts), *not* awaited there — the request path never waits on a drain (I1). An
 * error is caught and logged with `safeErrorLabel` plus the route; it never reaches an unhandled
 * rejection, and never propagates to a caller that chose not to await this.
 *
 * Returns the promise of whichever run will next settle, which only a test needs: a production
 * caller fires this and moves on.
 */
const backgroundSyncs = new WeakMap<SyncDeps, { running: Promise<void>; pending: boolean }>();

export function kickBackgroundSync(deps: SyncDeps): Promise<void> {
  const existing = backgroundSyncs.get(deps);
  if (existing) {
    existing.pending = true;
    return existing.running;
  }
  const state = { running: undefined as unknown as Promise<void>, pending: false };
  const run = (): Promise<void> =>
    syncSite(deps)
      .then(() => undefined)
      .catch((err) => {
        console.error(`[public-site] background site sync failed (POST /events) ${safeErrorLabel(err)}`);
      })
      .then((): void | Promise<void> => {
        if (state.pending) {
          state.pending = false;
          return (state.running = run());
        }
        backgroundSyncs.delete(deps);
      });
  state.running = run();
  backgroundSyncs.set(deps, state);
  return state.running;
}
