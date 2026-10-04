import type { NewsApiClient } from "./news-api-client";
import { HOME_COUNT, POST_KEY, postPath, resyncPostPages, stateAndBanner, tryHome } from "./rebuild";
import { renderHomePage, renderPostPage, type SiteInfo } from "./render";
import type { SiteStorage } from "./storage";

/** How many of the latest posts to rebuild when the output folder is found empty — generous
 * (most sites publish far fewer than this in their whole history) since this only runs once,
 * right after a cold start, when the alternative is a 404 for every page until the next event
 * happens to rebuild it. */
const DEFAULT_COUNT = 200;

/**
 * Task 1: SiteGround unpacks each deploy into a brand-new folder, so a redeploy can leave the
 * public site's `OUTPUT_DIR` empty even though DATA_DIR itself survived (e.g. the very first
 * deploy after this fix, or DATA_DIR pointed somewhere new) — every `/site` page would 404
 * until the next `site.rebuild_requested` event happened to touch it. Called once at startup
 * (see start.ts): if `index.html` is already there, the bootstrap render below is a no-op
 * (`null`) — otherwise it renders the home page and the latest `count` posts from the News
 * API, the same way createRebuildHandler would if it received a rebuild event for every one of
 * them.
 *
 * Plan 3d task 4 fix round 1 (CRITICAL): regardless of whether the bootstrap render runs, this
 * always also resyncs the Blue Bridge banner/TEST state onto every post page already on disk
 * (rebuild.ts's `resyncPostPages`) — a site that survived the redeploy (so the bootstrap is a
 * no-op) still needs its existing post pages fixed the first time this ships, or whenever
 * granville changes between rebuild events. Tolerant of a News API outage (logs and skips;
 * never fails startup) — unlike `createRebuildHandler`, which lets the same failure propagate
 * so the dispatcher retries (Important 1).
 */
export async function selfHeal(deps: { newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean; count?: number }): Promise<{ rebuilt: number } | null> {
  const { newsApi, storage, site, test, count = DEFAULT_COUNT } = deps;

  // One tolerant home() fetch covers both the resync below and, if needed, the bootstrap
  // render's own banner — a failure (logged inside tryHome) means both proceed without one.
  const home = await tryHome(newsApi);
  const computed = home ? stateAndBanner(home.granville, test, new Date()) : null;
  if (computed) {
    await resyncPostPages({ newsApi, storage, site }, computed.state, computed.banner);
  }

  if (await storage.exists("index.html")) return null;

  const opts = { test, banner: computed?.banner ?? null };

  const posts = await newsApi.latestHome(count);

  // Fix round 1: post pages first, index.html LAST — index.html's existence is the signal
  // this function (and the next cold start) uses to decide "already healed, nothing to do"
  // (the check above). Writing it first would mark the job done before a single post page
  // was actually written; if a later post write then failed, the next start would see
  // index.html and skip retrying, leaving some post pages permanently missing. Writing it
  // last means any failure midway leaves index.html absent, so the next start retries
  // everything from scratch.
  let rebuilt = 0;
  for (const post of posts) {
    if (!POST_KEY.test(post.key)) {
      console.warn(`[public-site] self-heal skipping post with invalid key ${JSON.stringify(post.key)}`);
      continue;
    }
    await storage.write(postPath(post.key), renderPostPage(post, site, opts));
    rebuilt++;
  }
  // The home page itself still lists only the normal count — `posts` is generous (above) so
  // every recent post page gets healed, but the home page shouldn't suddenly show 200 items.
  await storage.write("index.html", renderHomePage(posts.slice(0, HOME_COUNT), site, opts));
  return { rebuilt };
}
