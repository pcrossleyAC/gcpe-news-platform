import type { EventHandler } from "@gcpe/events";
import type { NewsApiClient } from "./news-api-client";
import { renderHomePage, renderPostPage, type SiteInfo } from "./render";
import { blueBridgeBanner } from "./site-env";
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
 * Plan 3d task 4: fetches Project Blue Bridge's `granville` once (never once per page) and
 * turns it into the banner text for this run — a News API failure never fails the rebuild, it
 * just means no banner this time (logged here, not thrown).
 */
export async function bannerFor(newsApi: NewsApiClient, test: boolean, now: () => Date = () => new Date()): Promise<string | null> {
  try {
    const { granville } = await newsApi.home();
    return blueBridgeBanner(granville, now(), test);
  } catch (e) {
    console.error(`[public-site] failed to fetch home() for the Blue Bridge banner: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export function createRebuildHandler(deps: { newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean }): EventHandler {
  return async (_tx, event) => {
    const { pages } = event.data as { pages: string[] };
    const banner = await bannerFor(deps.newsApi, deps.test);
    const opts = { test: deps.test, banner };
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
      const post = await deps.newsApi.getPost(key);
      // The output path always uses the requested, validated `key` — never the API
      // response's unvalidated post.key. A post.key of ".." or "a/b" would otherwise let a
      // malicious/buggy News API response write outside releases/<key>/, and a casing
      // difference between the write path and the unpublish path could leave a page live
      // after its post was unpublished. Skip (no write, no remove) rather than throwing, so
      // a bad response can't poison the event and force endless dispatcher retries.
      if (post && post.key.toLowerCase() !== key.toLowerCase()) {
        console.warn(`[public-site] skipping page post:${key}: News API returned a different key (${JSON.stringify(post.key)})`);
        continue;
      }
      const path = postPath(key);
      if (post) await deps.storage.write(path, renderPostPage(post, deps.site, opts));
      else await deps.storage.remove(path);
    }
  };
}
