import type { SiteBuilder } from "./builder";
import type { NewsApiClient } from "./news-api-client";
import { chromeChanged, enqueueSiteWrite, stateAndBanner, tryHome, writeSiteState } from "./rebuild";
import type { SiteInfo } from "./render";
import type { SiteStorage } from "./storage";
import { writeSubscribePages } from "./subscribe-pages";

/**
 * Runs once at startup (see start.ts): makes sure the output folder actually has every page it
 * should, the same way `createRebuildHandler`'s chrome-change path would — either because the
 * folder came up empty (e.g. a SiteGround redeploy into a brand-new folder) or because the
 * chrome baked into every page (Blue Bridge, the test flag, `RENDER_CHROME_VERSION`, the base
 * URL) differs from the last run's marker.
 *
 * Tolerant of a News API outage: `tryHome` never throws, so a failed `home()` just means the
 * subscribe pages are written with no banner and nothing else runs this time — unlike
 * `createRebuildHandler`, whose `home()` failure propagates so the event is retried. Runs
 * inside the same `enqueueSiteWrite` queue as `createRebuildHandler`, so this startup pass and
 * an inbound rebuild event in the same process can never interleave (see `enqueueSiteWrite`'s
 * doc comment).
 */
export function selfHeal(deps: { builder: SiteBuilder; newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean }): Promise<{ rebuilt: number } | null> {
  const { builder, newsApi, storage, site, test } = deps;

  return enqueueSiteWrite(storage, async () => {
    const home = await tryHome(newsApi);
    const computed = home ? stateAndBanner(home.granville, test, new Date()) : null;
    const opts = { test, banner: computed?.banner ?? null };

    // Cheap and stateless, so rewritten on every start regardless of what follows.
    await writeSubscribePages(storage, site, opts);

    if (!computed) return null; // News API unreachable: nothing more can be rendered correctly now

    const needsBuild = (await chromeChanged(storage, computed.state, site)) || !(await storage.exists("index.html"));
    if (!needsBuild) {
      await builder.renderPage("static", opts);
      return null;
    }

    const r = await builder.buildAll(opts);
    if (r.failures === 0) await writeSiteState(storage, computed.state, site);
    return { rebuilt: r.posts };
  });
}
