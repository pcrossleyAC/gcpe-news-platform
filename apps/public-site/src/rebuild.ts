import type { NewsApiClient } from "./news-api-client";
import type { SiteInfo } from "./render";
import { blueBridgeBanner, isGranvilleOn } from "./site-env";
import type { SiteStorage } from "./storage";

/**
 * The site-wide render chrome a page bakes in — whether Project Blue Bridge is on, and whether
 * this is a test site. Deliberately *not* the rendered banner text (which carries the age in
 * years): that changes every day His Majesty's birthday ticks over, and the daily age bump
 * alone must never trigger a full rebuild of every page on disk. The marker only has to change
 * exactly when the page chrome itself changes — on/off and test/production is exactly that,
 * nothing more.
 */
export interface SiteRenderState {
  granvilleOn: boolean;
  test: boolean;
}

/** Not served publicly: a leading dot (denied by the `/site` static mount's `dotfiles: "deny"`
 * — see apps/stack/src/stack.ts) and never referenced by any rendered page. */
export const SITE_STATE_PATH = ".site-state.json";

/**
 * Bump whenever every page's baked-in chrome changes (links, header, page types, ...), so the
 * next startup/event rebuilds every page already on disk. 3: the full site (theme, every page
 * type, archives, feeds, sitemaps; spec §6).
 */
export const RENDER_CHROME_VERSION = 3;

/** What the marker file holds: the render state plus what else every page bakes in — the
 * chrome version and the base URL (links carry its path, so a PUBLIC_SITE_URL change must
 * re-render too). A marker written before these existed reads as chrome 1, no base URL. */
interface SiteStateMarker extends SiteRenderState {
  chrome: number;
  baseUrl: string | null;
}

async function readSiteState(storage: SiteStorage): Promise<SiteStateMarker | null> {
  const raw = await storage.read(SITE_STATE_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SiteStateMarker>;
    if (typeof parsed.granvilleOn === "boolean" && typeof parsed.test === "boolean") {
      return {
        granvilleOn: parsed.granvilleOn,
        test: parsed.test,
        chrome: typeof parsed.chrome === "number" ? parsed.chrome : 1,
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : null,
      };
    }
  } catch {
    // Malformed/foreign content — treated the same as "no marker" below.
  }
  return null;
}

/** True when the chrome every page bakes in differs from the marker the last full build left. */
export async function chromeChanged(storage: SiteStorage, state: SiteRenderState, site: SiteInfo): Promise<boolean> {
  const previous = await readSiteState(storage);
  return !(previous && previous.granvilleOn === state.granvilleOn && previous.test === state.test && previous.chrome === RENDER_CHROME_VERSION && previous.baseUrl === site.baseUrl);
}

export async function writeSiteState(storage: SiteStorage, state: SiteRenderState, site: SiteInfo): Promise<void> {
  const marker: SiteStateMarker = { granvilleOn: state.granvilleOn, test: state.test, chrome: RENDER_CHROME_VERSION, baseUrl: site.baseUrl };
  await storage.write(SITE_STATE_PATH, JSON.stringify(marker));
}

/** `granville` and `test` together, as both the render state (for the marker) and the banner
 * text (for this render, with today's age). */
export function stateAndBanner(granville: string | null, test: boolean, now: Date): { state: SiteRenderState; banner: string | null } {
  return { state: { granvilleOn: isGranvilleOn(granville), test }, banner: blueBridgeBanner(granville, now, test) };
}

/**
 * A tolerant `home()` fetch: `null` on failure (logged here), never throws. Used only where a
 * News API outage must not fail the caller outright — selfHeal.ts's startup path.
 * `createRebuildHandler`/`syncSite` (`sync.ts`) do *not* use this — a `home()` failure there
 * propagates, like any other News API failure, so the event receiver 500s and the dispatcher
 * retries instead of silently publishing a stale/missing banner.
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
 * `selfHeal` runs once at startup, *after* `app.listen()` (main.ts/stack.ts), so it can overlap
 * an inbound `site.rebuild_requested` rebuild in the same process — both would otherwise read
 * `.site-state.json`, render under two different granville/test states (each fetched
 * independently, at different times), and whichever wrote the marker last "wins", leaving some
 * pages with the wrong banner until the next state change.
 *
 * This serialises every one of those turns — the whole body of `syncSite` (`sync.ts`, which
 * `createRebuildHandler` calls) and of `selfHeal` — through one promise chain *per `SiteStorage`
 * instance*. The public site is a single process with exactly one `SiteStorage` (its
 * `OUTPUT_DIR`), so a module-level map keyed by that instance is enough; there is no
 * cross-process coordination to do. Each turn's own `home()`/`test` read happens *inside*
 * `turn()`, once its slot in the queue actually starts — never before `enqueueSiteWrite` is
 * called — so two overlapping callers can never race: the second's `turn()` doesn't even begin
 * (let alone call `home()`) until the first's has fully settled.
 *
 * A turn that rejects never wedges the queue: the chain variable itself is reset to an
 * already-settled promise after every turn regardless of outcome, so the *next* queued turn
 * still runs — but `enqueueSiteWrite`'s own return value still rejects with that turn's error,
 * so `syncSite`/`createRebuildHandler` can still let it propagate and `selfHeal` can still catch
 * and log it.
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
