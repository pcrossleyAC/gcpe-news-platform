import type { NewsApiClient } from "./news-api-client";
import { POST_KEY, postPath } from "./rebuild";
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
 * (see start.ts): if `index.html` is already there, this is a no-op (`null`) — otherwise it
 * renders the home page and the latest `count` posts from the News API, the same way
 * createRebuildHandler would if it received a rebuild event for every one of them.
 */
export async function selfHeal(deps: { newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; count?: number }): Promise<{ rebuilt: number } | null> {
  const { newsApi, storage, site, count = DEFAULT_COUNT } = deps;
  if (await storage.exists("index.html")) return null;

  const posts = await newsApi.latestHome(count);
  await storage.write("index.html", renderHomePage(posts, site));

  let rebuilt = 0;
  for (const post of posts) {
    if (!POST_KEY.test(post.key)) {
      console.warn(`[public-site] self-heal skipping post with invalid key ${JSON.stringify(post.key)}`);
      continue;
    }
    await storage.write(postPath(post.key), renderPostPage(post, site));
    rebuilt++;
  }
  return { rebuilt };
}
