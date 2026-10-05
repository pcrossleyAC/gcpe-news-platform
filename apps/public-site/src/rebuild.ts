import type { EventHandler } from "@gcpe/events";
import type { NewsApiClient } from "./news-api-client";
import { renderHomePage, renderPostPage, type PageOptions, type SiteInfo } from "./render";
import { blueBridgeBanner, isGranvilleOn } from "./site-env";
import type { SiteStorage } from "./storage";

/** A valid post key, same shape NRMS/News API produce — shared with self-heal.ts so both
 * places validate a post key the same way before treating it as a filesystem path component. */
export const POST_KEY = /^[A-Za-z0-9-]+$/;
/** How many of the latest posts the home page lists — shared with self-heal.ts so a cold-start
 * rebuild (which fetches far more, to heal every recent post page) still renders a normal-sized
 * home page rather than all of them. */
export const HOME_COUNT = 10;

/** The on-disk path a post page is written to/removed from — shared with self-heal.ts so
 * neither place duplicates this string shape. */
export function postPath(key: string): string {
  return `releases/${key}/index.html`;
}

/**
 * Plan 3d task 4 fix round 1 (CRITICAL): the site-wide render chrome a post page bakes in —
 * whether Project Blue Bridge is on, and whether this is a test site. Deliberately *not* the
 * rendered banner text (which carries the age in years): that changes every day His Majesty's
 * birthday ticks over, and the daily age bump alone must never trigger a full re-render of
 * every post page on disk. The marker only has to change exactly when the page chrome itself
 * changes — on/off and test/production is exactly that, nothing more.
 */
export interface SiteRenderState {
  granvilleOn: boolean;
  test: boolean;
}

/** Not served publicly: a leading dot (denied by the `/site` static mount's `dotfiles: "deny"`
 * — see apps/stack/src/stack.ts) and never referenced by any rendered page. */
export const SITE_STATE_PATH = ".site-state.json";

async function readSiteState(storage: SiteStorage): Promise<SiteRenderState | null> {
  const raw = await storage.read(SITE_STATE_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SiteRenderState>;
    if (typeof parsed.granvilleOn === "boolean" && typeof parsed.test === "boolean") {
      return { granvilleOn: parsed.granvilleOn, test: parsed.test };
    }
  } catch {
    // Malformed/foreign content — treated the same as "no marker" below.
  }
  return null;
}

async function writeSiteState(storage: SiteStorage, state: SiteRenderState): Promise<void> {
  await storage.write(SITE_STATE_PATH, JSON.stringify(state));
}

/** `granville` and `test` together, as both the render state (for the marker) and the banner
 * text (for this render, with today's age). */
export function stateAndBanner(granville: string | null, test: boolean, now: Date): { state: SiteRenderState; banner: string | null } {
  return { state: { granvilleOn: isGranvilleOn(granville), test }, banner: blueBridgeBanner(granville, now, test) };
}

/**
 * Fetches, renders and writes (or removes) one post page by its requested key — shared by
 * `createRebuildHandler`'s per-event post handling and `resyncPostPages` below, so there's one
 * place that knows the key-casing/path-safety rule: the output path always uses the
 * *requested* key, never the News API response's unvalidated `post.key` (a mismatch, e.g. a
 * `post.key` of ".." or a casing difference, is skipped — logged, not written — rather than
 * trusted).
 */
export async function renderExistingPost(newsApi: NewsApiClient, storage: SiteStorage, site: SiteInfo, key: string, opts: PageOptions): Promise<void> {
  const post = await newsApi.getPost(key);
  const path = postPath(key);
  if (!post) {
    await storage.remove(path);
    return;
  }
  if (post.key.toLowerCase() !== key.toLowerCase()) {
    console.warn(`[public-site] skipping page post:${key}: News API returned a different key (${JSON.stringify(post.key)})`);
    return;
  }
  await storage.write(path, renderPostPage(post, site, opts));
}

/**
 * Plan 3d task 4 fix round 1 (CRITICAL): post pages are static files with the Blue Bridge
 * banner/TEST noindex baked in at render time — a home-only `site.content.changed` rebuild
 * (`pages: ["home"]`) never otherwise touches them, so after a mistaken ON→OFF every post
 * rendered while ON would keep the death announcement indefinitely, and after a real ON,
 * existing posts would never show it.
 *
 * Compares `state` against the marker file left by the last run: unchanged (including a first
 * run against a brand-new, still-empty output dir where `storage.listDirs` finds nothing) is a
 * no-op; changed, or no marker at all (first run after this fix, or a pre-existing site), means
 * every post page already on disk — enumerated directly from the output folder, which is
 * exactly the set that needs fixing — is re-rendered with the new chrome, then the marker is
 * updated to match.
 */
export async function resyncPostPages(deps: { newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo }, state: SiteRenderState, banner: string | null): Promise<void> {
  const previous = await readSiteState(deps.storage);
  if (previous && previous.granvilleOn === state.granvilleOn && previous.test === state.test) return;

  const opts: PageOptions = { test: state.test, banner };
  // Minor 1 (fix round 3): one post whose getPost keeps failing (or whose write fails) must not
  // block every other post's resync, nor the marker that lets this whole function short-circuit
  // on a later unrelated run. Skipped and logged here; the marker is withheld below so the next
  // run retries every post (including this one) rather than concluding the resync is done.
  let hadFailure = false;
  for (const key of await deps.storage.listDirs("releases")) {
    if (!POST_KEY.test(key)) continue; // defensive — every name we ever wrote already matches this
    try {
      await renderExistingPost(deps.newsApi, deps.storage, deps.site, key, opts);
    } catch (e) {
      hadFailure = true;
      console.error(`[public-site] resync: skipping post:${key} this run (will retry next time): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (hadFailure) return;

  // I1 (fix round 3): index.html is itself a static page with the same banner/noindex chrome
  // baked in as every post page — only re-render it if it's already there (a brand-new output
  // dir has none yet; that first render is selfHeal's bootstrap job, not this one's).
  if (await deps.storage.exists("index.html")) {
    await deps.storage.write("index.html", renderHomePage(await deps.newsApi.latestHome(HOME_COUNT), deps.site, opts));
  }
  await writeSiteState(deps.storage, state);
}

/**
 * A tolerant `home()` fetch: `null` on failure (logged here), never throws. Used only where a
 * News API outage must not fail the caller outright — selfHeal.ts's startup path. Important 1
 * (fix round 1): `createRebuildHandler` below does *not* use this — a `home()` failure there
 * propagates, like a `getPost`/`latestHome` failure already does, so the event receiver 500s
 * and the dispatcher retries instead of silently publishing a stale/missing banner.
 */
export async function tryHome(newsApi: NewsApiClient): Promise<{ granville: string | null } | null> {
  try {
    return await newsApi.home();
  } catch (e) {
    console.error(`[public-site] failed to fetch home() for the Blue Bridge banner: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Fix round 2 (Important): `selfHeal` runs once at startup, *after* `app.listen()`
 * (main.ts/stack.ts), so it can overlap an inbound `site.rebuild_requested` rebuild in the same
 * process — both would otherwise read `.site-state.json`, render under two different
 * granville/test states (each fetched independently, at different times), and whichever wrote
 * the marker last "wins", leaving some pages with the wrong banner until the next state change.
 *
 * This serialises every one of those turns — the whole body of `createRebuildHandler` below and
 * of `selfHeal` — through one promise chain *per `SiteStorage` instance*. The public site is a
 * single process with exactly one `SiteStorage` (its `OUTPUT_DIR`), so a module-level map keyed
 * by that instance is enough; there is no cross-process coordination to do. Each turn's own
 * `home()`/`test` read happens *inside* `turn()`, once its slot in the queue actually starts —
 * never before `enqueueSiteWrite` is called — so two overlapping callers can never race: the
 * second's `turn()` doesn't even begin (let alone call `home()`) until the first's has fully
 * settled.
 *
 * A turn that rejects never wedges the queue: the chain variable itself is reset to an
 * already-settled promise after every turn regardless of outcome, so the *next* queued turn
 * still runs — but `enqueueSiteWrite`'s own return value still rejects with that turn's error,
 * so `createRebuildHandler` can still let it propagate (Important 1) and `selfHeal` can still
 * catch and log it.
 */
const siteWriteQueues = new WeakMap<SiteStorage, Promise<unknown>>();

export function enqueueSiteWrite<T>(storage: SiteStorage, turn: () => Promise<T>): Promise<T> {
  const previous = siteWriteQueues.get(storage) ?? Promise.resolve();
  const settledPrevious = previous.then(
    () => undefined,
    () => undefined,
  );
  const result = settledPrevious.then(turn);
  siteWriteQueues.set(
    storage,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

export function createRebuildHandler(deps: { newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean }): EventHandler {
  return (_tx, event) =>
    enqueueSiteWrite(deps.storage, async () => {
      const { pages } = event.data as { pages: string[] };
      // Important 1 (fix round 1): let a home() failure propagate — never swallow it and write
      // pages without (or with a stale) banner while reporting success. Fix round 2: this read
      // happens inside the queued turn, not before — see enqueueSiteWrite's doc comment.
      const { granville } = await deps.newsApi.home();
      const { state, banner } = stateAndBanner(granville, deps.test, new Date());
      const opts: PageOptions = { test: deps.test, banner };

      // CRITICAL fix (round 1): resync every post page already on disk *before* this event's
      // own pages, so a home-only rebuild still fixes posts the banner/test state left stale.
      await resyncPostPages(deps, state, banner);

      for (const id of new Set(pages)) {
        if (id === "home") {
          await deps.storage.write("index.html", renderHomePage(await deps.newsApi.latestHome(HOME_COUNT), deps.site, opts));
          continue;
        }
        const key = id.startsWith("post:") ? id.slice(5) : null;
        if (!key || !POST_KEY.test(key)) {
          console.warn(`[public-site] skipping unknown page id ${JSON.stringify(id)}`);
          continue;
        }
        await renderExistingPost(deps.newsApi, deps.storage, deps.site, key, opts);
      }
    });
}
