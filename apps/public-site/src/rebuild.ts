import type { EventHandler } from "@gcpe/events";
import type { NewsApiClient } from "./news-api-client";
import { renderHomePage, renderPostPage, type SiteInfo } from "./render";
import type { SiteStorage } from "./storage";

const KEY = /^[A-Za-z0-9-]+$/;
const HOME_COUNT = 10;

export function createRebuildHandler(deps: { newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo }): EventHandler {
  return async (_tx, event) => {
    const { pages } = event.data as { pages: string[] };
    for (const id of new Set(pages)) {
      if (id === "home") {
        await deps.storage.write("index.html", renderHomePage(await deps.newsApi.latestHome(HOME_COUNT), deps.site));
        continue;
      }
      const key = id.startsWith("post:") ? id.slice(5) : null;
      if (!key || !KEY.test(key)) {
        console.warn(`[public-site] skipping unknown page id ${JSON.stringify(id)}`);
        continue;
      }
      const post = await deps.newsApi.getPost(key);
      const path = `releases/${post?.key ?? key}/index.html`;
      if (post) await deps.storage.write(path, renderPostPage(post, deps.site));
      else await deps.storage.remove(path);
    }
  };
}
