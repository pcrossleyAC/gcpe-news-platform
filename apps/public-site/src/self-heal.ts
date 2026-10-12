import { drainQueue } from "./drain";
import { chromeChanged, enqueueSiteWrite, stateAndBanner, tryHome, writeSiteState } from "./rebuild";
import { enqueueRebuildAll } from "./rebuild-all";
import type { SyncDeps } from "./sync";
import { writeSubscribePages } from "./subscribe-pages";

/**
 * Runs once at startup (see start.ts): makes sure the output folder actually has every page it
 * should, the same way `syncSite`'s chrome-change path would — either because the folder came
 * up empty (e.g. a SiteGround redeploy into a brand-new folder) or because the chrome baked
 * into every page (Blue Bridge, the test flag, `RENDER_CHROME_VERSION`, the base URL) differs
 * from the last run's marker. A full rebuild is only *queued* here (spec §6.2) — rendering is
 * `drainQueue`'s job, budgeted the same as every other tick.
 *
 * Tolerant of a News API outage: `tryHome` never throws, so a failed `home()` just means the
 * subscribe pages are written with no banner and nothing else runs this time — unlike
 * `syncSite`, whose `home()` failure propagates and rejects that turn (rebuild.ts's doc comment
 * on `tryHome` says what becomes of that rejection since I1). Runs inside the same
 * `enqueueSiteWrite` queue as `syncSite`, so this startup pass and an inbound rebuild event in
 * the same process can never interleave (see `enqueueSiteWrite`'s doc comment).
 */
export function selfHeal(deps: SyncDeps): Promise<{ rebuilt: number } | null> {
  const { newsApi, storage, site, test } = deps;

  return enqueueSiteWrite(storage, async () => {
    const home = await tryHome(newsApi);
    const computed = home ? stateAndBanner(home.granville, test, new Date()) : null;
    const pageOpts = { test, banner: computed?.banner ?? null };

    // Cheap and stateless, so rewritten on every start regardless of what follows.
    await writeSubscribePages(storage, site, pageOpts);

    if (!computed) return null; // News API unreachable: nothing more can be rendered correctly now

    if ((await chromeChanged(storage, computed.state, site)) || !(await storage.exists("index.html"))) {
      await enqueueRebuildAll(deps.db, deps.builder);
      await writeSiteState(storage, computed.state, site);
    }

    const r = await drainQueue({ db: deps.db, builder: deps.builder }, { budget: deps.batch, pageOpts });
    return r.rendered > 0 ? { rebuilt: r.rendered } : null;
  });
}
