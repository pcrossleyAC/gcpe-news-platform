import type { SiteSettings } from "@gcpe/site-settings";
import type { NewsApiClient } from "./news-api-client";
import { ministryMenuHash, type MenuMinistry } from "./ministry-menu";
import type { SiteInfo } from "./render";
import { DEFAULT_TIME_ZONE, settingsHashes } from "./settings";
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
  /** The site settings, one hash per section (settings.ts's settingsHashes). Every page bakes in
   * the footer (and its copyright year), so `footerHash` is chrome like Blue Bridge; the others
   * reach only some pages — see `chromeChanges`. */
  footerHash: string;
  themeHash: string;
  bannerHash: string;
  connectHash: string;
  ministryPagesHash: string;
  /** ministry-menu.ts's hash of the header menu every page bakes in. Not one of `HASHES`: it is
   * not a settings section, and a marker written before it existed has none (see `readSiteState`). */
  ministryMenuHash: string;
}

/** The pages a settings section reaches, other than through every page's footer. */
export type SectionPages = "static" | "connect" | "ministryPages";

/** Not served publicly: a leading dot (denied by the `/site` static mount's `dotfiles: "deny"`
 * — see apps/stack/src/stack.ts) and never referenced by any rendered page. */
export const SITE_STATE_PATH = ".site-state.json";

/**
 * Bump whenever every page's baked-in chrome changes (links, header, page types, ...), so the
 * next startup/event rebuilds every page already on disk. 3: the full site (theme, every page
 * type, archives, feeds, sitemaps; spec §6). 4: the site settings' footer and banner placeholder.
 * 5: ministry Media Contacts and filter-only search links (PR #46). 6: the legacy <head> (favicon,
 * html.js marker, vendored legacy CSS, overrides.css) and the theme's legacy variable aliases. Bump for body render changes
 * too: pages already on disk keep their old HTML until something rebuilds them.
 */
export const RENDER_CHROME_VERSION = 6;

/** What the marker file holds: the render state plus what else every page bakes in — the
 * chrome version and the base URL (links carry its path, so a PUBLIC_SITE_URL change must
 * re-render too). A marker written before these existed reads as chrome 1, no base URL. */
interface SiteStateMarker extends SiteRenderState {
  chrome: number;
  baseUrl: string | null;
}

const HASHES = ["footerHash", "themeHash", "bannerHash", "connectHash", "ministryPagesHash"] as const;

/** `ministryMenuHash` as read from a marker: absent (written before this existed) is `null`, and
 * `chromeChanges` then treats it as matching. */
type ReadMarker = Omit<SiteStateMarker, "ministryMenuHash"> & { ministryMenuHash: string | null };

async function readSiteState(storage: SiteStorage): Promise<ReadMarker | null> {
  const raw = await storage.read(SITE_STATE_PATH);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SiteStateMarker>;
    if (typeof parsed.granvilleOn === "boolean" && typeof parsed.test === "boolean") {
      // A marker written before the site settings has no hashes: "" never matches a real one.
      const hashes = Object.fromEntries(HASHES.map((k) => [k, typeof parsed[k] === "string" ? parsed[k] : ""])) as Pick<SiteRenderState, (typeof HASHES)[number]>;
      return {
        granvilleOn: parsed.granvilleOn,
        test: parsed.test,
        ...hashes,
        ministryMenuHash: typeof parsed.ministryMenuHash === "string" ? parsed.ministryMenuHash : null,
        chrome: typeof parsed.chrome === "number" ? parsed.chrome : 1,
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : null,
      };
    }
  } catch {
    // Malformed/foreign content — treated the same as "no marker" below.
  }
  return null;
}

/**
 * What differs from the marker the last build left. `all`: the chrome every page bakes in (Blue
 * Bridge, the test flag, the chrome version, the base URL, the footer, the ministries menu) — every page. Otherwise
 * `sections`: a theme or banner change reaches only the `static` page (theme.css,
 * site-banner.json), a connect change only the Connect page, a ministryPages change only the
 * ministry pages (spec "Delivery": the cheapest correct effect per section).
 */
export async function chromeChanges(storage: SiteStorage, state: SiteRenderState, site: SiteInfo): Promise<{ all: boolean; sections: SectionPages[]; adoptMenuHash?: boolean }> {
  const previous = await readSiteState(storage);
  const all = !(
    previous &&
    previous.granvilleOn === state.granvilleOn &&
    previous.test === state.test &&
    previous.chrome === RENDER_CHROME_VERSION &&
    previous.baseUrl === site.baseUrl &&
    previous.footerHash === state.footerHash &&
    (previous.ministryMenuHash === null || previous.ministryMenuHash === state.ministryMenuHash)
  );
  if (all || !previous) return { all: true, sections: [] };
  const sections: SectionPages[] = [];
  if (previous.themeHash !== state.themeHash || previous.bannerHash !== state.bannerHash) sections.push("static");
  if (previous.connectHash !== state.connectHash) sections.push("connect");
  if (previous.ministryPagesHash !== state.ministryPagesHash) sections.push("ministryPages");
  // A marker from before the menu hash: nothing to rebuild for it, but the hash must be recorded
  // or a later menu change would still read as matching.
  return { all: false, sections, adoptMenuHash: previous.ministryMenuHash === null };
}

/**
 * `state` with the previous marker's settings hashes, when there is a marker: for a turn whose
 * settings fetch failed with nothing persisted (`fallbackDefaults`), so the stand-in defaults
 * are not compared and never queue a settings rebuild by themselves, while the rest of the
 * chrome is still compared. This only shapes the *comparison*: when a rebuild-all is queued
 * anyway, applyChromeChanges records the turn's own state (the defaults' hashes), because every
 * page was then rendered with the defaults. No marker (a first-ever start): `state` as is.
 *
 * A *fetched* default (the News API answered 404: nothing published yet) is not this case: it
 * is the settings, so its hashes are compared and recorded like a published document's.
 */
export async function keepSettingsHashes(storage: SiteStorage, state: SiteRenderState): Promise<SiteRenderState> {
  const previous = await readSiteState(storage);
  if (!previous) return state;
  const kept = Object.fromEntries(HASHES.map((k) => [k, previous[k]])) as Pick<SiteRenderState, (typeof HASHES)[number]>;
  return { ...state, ...kept };
}

export async function writeSiteState(storage: SiteStorage, state: SiteRenderState, site: SiteInfo): Promise<void> {
  const marker: SiteStateMarker = { ...state, chrome: RENDER_CHROME_VERSION, baseUrl: site.baseUrl };
  await storage.write(SITE_STATE_PATH, JSON.stringify(marker));
}

/** `granville`, `test`, the site settings and the ministries menu together, as both the render state (for the
 * marker) and the banner text (for this render, with today's age). */
export function stateAndBanner(granville: string | null, test: boolean, now: Date, settings: SiteSettings, site: Pick<SiteInfo, "timeZone">, menu: MenuMinistry[] | null): { state: SiteRenderState; banner: string | null } {
  return {
    state: { granvilleOn: isGranvilleOn(granville), test, ...settingsHashes(settings, site.timeZone ?? DEFAULT_TIME_ZONE, now), ministryMenuHash: ministryMenuHash(menu) },
    banner: blueBridgeBanner(granville, now, test),
  };
}

/**
 * A tolerant `home()` fetch: `null` on failure (logged here), never throws. Used only where a
 * News API outage must not fail the caller outright — selfHeal.ts's startup path. `syncSite`
 * (`sync.ts`) does *not* use this — a `home()` failure there propagates and rejects that turn
 * rather than silently publishing a stale/missing banner. Since I1, that turn normally runs in
 * the background (`kickBackgroundSync`, kicked after `createRebuildHandler`'s own transaction
 * commits), so the rejection is caught and logged there, not surfaced to the event receiver; the
 * tick/standalone loop's own `syncSite` call is the backstop that retries it.
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
