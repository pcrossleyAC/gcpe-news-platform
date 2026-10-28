import { safeErrorLabel } from "@gcpe/http-kit";
import { drainQueue } from "./drain";
import { ministryMenu, type MenuMinistry } from "./ministry-menu";
import { enqueueSiteWrite, tryHome } from "./rebuild";
import { applyChromeChanges, turnOptions, type SyncDeps } from "./sync";
import { writeBuiltinAssets } from "./site-assets";
import { writeSubscribePages } from "./subscribe-pages";

/** A tolerant ministries fetch, like `tryHome`: `null` on failure, logged. */
async function tryMinistryMenu(deps: SyncDeps): Promise<MenuMinistry[] | null> {
  try {
    return ministryMenu(await deps.newsApi.ministries());
  } catch (err) {
    console.error(`[public-site] failed to fetch ministries() for the header menu ${safeErrorLabel(err)}`);
    return null;
  }
}

/**
 * Runs once at startup (see start.ts): makes sure the output folder actually has every page it
 * should, the same way `syncSite`'s chrome-change path would — either because the folder came
 * up empty (e.g. a SiteGround redeploy into a brand-new folder) or because the chrome baked
 * into every page (Blue Bridge, the test flag, `RENDER_CHROME_VERSION`, the base URL, the site
 * settings' footer) differs from the last run's marker — or, for a settings section that reaches
 * only some pages, queues just those (rebuild.ts's chromeChanges). A rebuild is only *queued*
 * here (spec §6.2) — rendering is `drainQueue`'s job, budgeted the same as every other tick.
 *
 * Tolerant of a News API outage: `tryHome` never throws, so a failed `home()` just means the
 * subscribe pages are written with no banner (or, with `ministries()` down, no ministries menu) and nothing else runs this time — unlike
 * `syncSite`, whose `home()` failure propagates and rejects that turn (rebuild.ts's doc comment
 * on `tryHome` says what becomes of that rejection since I1). Runs inside the same
 * `enqueueSiteWrite` queue as `syncSite`, so this startup pass and an inbound rebuild event in
 * the same process can never interleave (see `enqueueSiteWrite`'s doc comment).
 */
export function selfHeal(deps: SyncDeps): Promise<{ rebuilt: number } | null> {
  const { newsApi, storage, site } = deps;

  return enqueueSiteWrite(storage, async () => {
    // First, and independent of the News API: the vendored CSS, logos, BC Sans, favicon and icon sprite every page links.
    await writeBuiltinAssets(storage);

    const home = await tryHome(newsApi);
    const menu = await tryMinistryMenu(deps);
    const turn = await turnOptions(deps, home?.granville ?? null, menu);
    const { pageOpts } = turn;

    // Cheap and stateless, so rewritten on every start regardless of what follows.
    await writeSubscribePages(storage, site, home ? pageOpts : { ...pageOpts, banner: null });

    if (!home || !menu) return null; // News API unreachable: nothing more can be rendered correctly now

    await applyChromeChanges(deps, turn, !(await storage.exists("index.html")));

    const r = await drainQueue({ db: deps.db, builder: deps.builder }, { budget: deps.batch, pageOpts });
    return r.rendered > 0 ? { rebuilt: r.rendered } : null;
  });
}
