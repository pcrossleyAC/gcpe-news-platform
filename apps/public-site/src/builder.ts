import type { DbOrTx } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { MinistryDto, MinistryProfileDto, PostDto } from "./dto";
import { renderRssFeed } from "./feeds";
import type { NewsApiClient } from "./news-api-client";
import { renderArchiveIndex, renderArchiveMonth } from "./pages/archive";
import { renderCategoryPage, renderMinistriesPage, renderMinistryPage } from "./pages/categories";
import { renderConnectPage } from "./pages/connect";
import { LATEST_COUNT } from "./pages/format";
import { renderHomePage } from "./pages/home";
import { renderReleasePage } from "./pages/release";
import { renderSearchPage } from "./pages/search";
import { indexEntryOf, membershipOfEntry, postIndex, type PostIndex } from "./post-index";
import { dependentPages, membershipOf } from "./rebuild-set";
import type { PageOptions, SiteInfo } from "./render";
import { categoryPageId, CATEGORY_KINDS, feedUrl, formatPageId, pageFiles, pageUrl, parsePageId, POST_KEY, type CategoryKind, type PageId } from "./site-paths";
import { renderSitemapIndex, renderUrlSet } from "./sitemaps";
import { writeStaticPages } from "./static-pages";
import type { SiteStorage } from "./storage";

/** The News API's post kinds (packages/events postKindSchema). */
export const POST_KINDS = ["releases", "stories", "factsheets", "updates", "advisories"] as const;

/** Per-run memo, so a run rendering many pages fetches the ministry list once. */
export interface RunCache {
  ministries?: Promise<MinistryDto[]>;
  profiles?: Promise<MinistryProfileDto[]>;
  /** Each lead ministry's latest posts (lower-cased key), the release page's related-band
   * fallback: fetched at most once per run, and only by a post with no related posts. */
  ministryLatest?: Map<string, Promise<PostDto[]>>;
}

/** How many of a ministry's latest posts the related band's fallback fetches: three to show, plus
 * the release itself, which may be among them. */
const MINISTRY_LATEST_COUNT = 4;

export interface SiteBuilder {
  /**
   * Renders (or removes) one page; returns the ids that now need rebuilding because of it. For a
   * post page, `tx` (if given) is where the `site_posts` index row is written (M1): the caller
   * can then enqueue those dependents and complete the queue row in that same transaction, so a
   * failure after rendering rolls the index write back too, instead of leaving it committed
   * ahead of a retry that would otherwise compute dependents from the already-updated row.
   * Absent, the index write goes straight to the pool, as it always did.
   */
  renderPage(pageId: string, opts: PageOptions, run?: RunCache, tx?: DbOrTx): Promise<string[]>;
  /** Renders the given pages, then their dependents. The first failure is logged and rethrown. */
  rebuild(pageIds: string[], opts: PageOptions): Promise<void>;
  /** Every post page, then every aggregate page (spec §6.2's "templates change" row). */
  buildAll(opts: PageOptions): Promise<{ posts: number; failures: number }>;
  /** Every key with a page today or due one: the News API's published keys, the index and the disk. */
  allPostKeys(): Promise<string[]>;
  /** Every non-post page id the site has (home, indexes, categories, months, sitemaps, static, connect). */
  aggregatePageIds(): Promise<string[]>;
  /** Every ministry page id — what a `ministryPages` settings change rebuilds. */
  ministryPageIds(): Promise<string[]>;
}

export function createSiteBuilder(deps: { newsApi: NewsApiClient; storage: SiteStorage; index: PostIndex; site: SiteInfo; assetsDir: string | null; searchApiBase?: string }): SiteBuilder {
  const { newsApi, storage, index, site } = deps;
  const ministries = (run: RunCache) => (run.ministries ??= newsApi.ministries());
  const profiles = (run: RunCache) => (run.profiles ??= newsApi.ministryProfiles());
  const removeAll = async (p: PageId) => {
    for (const f of pageFiles(p)) await storage.remove(f);
  };
  const featured = async (top: string | null, feature: string | null) => {
    const found = await newsApi.postsByKeys([top, feature].filter((k): k is string => !!k));
    const pick = (k: string | null) => (k ? (found.find((p) => p.key.toLowerCase() === k.toLowerCase()) ?? null) : null);
    return { top: pick(top), feature: pick(feature) };
  };

  /**
   * Home's News by Sector: the active sectors by name, each with its newest post (legacy TopSectors).
   * A side box, so it never fails the home render: a sector whose fetch fails is left out (logged),
   * and so is the whole box when the sector list can't be read. At most SECTOR_FETCHES run at once.
   */
  async function sectorsWithLatest(): Promise<{ key: string; name: string; latest: PostDto | null }[]> {
    let active: Awaited<ReturnType<NewsApiClient["categories"]>>;
    try {
      active = (await newsApi.categories("sectors")).filter((c) => c.isActive);
    } catch (err) {
      console.error(`[public-site] home: News by Sector left out, the sector list is unavailable ${safeErrorLabel(err)}`);
      return [];
    }
    const withLatest = await mapLimit(active, SECTOR_FETCHES, async (c) => {
      try {
        return { key: c.key, name: c.name, latest: (await newsApi.latest("sectors", c.key, 1))[0] ?? null };
      } catch (err) {
        console.error(`[public-site] home: News by Sector leaves out sector:${c.key} this render ${safeErrorLabel(err)}`);
        return { key: c.key, name: c.name, latest: null };
      }
    });
    return withLatest.sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  async function renderPost(key: string, opts: PageOptions, run: RunCache, tx?: DbOrTx): Promise<string[]> {
    const p: PageId = { type: "post", key };
    // The write below goes through `tx` when the caller gave one (M1), so a transaction that
    // fails after this point rolls the write back too — the next attempt's own `index.get`
    // then reads the same `before` this attempt did, not a half-applied one.
    const writeIndex = tx ? postIndex(tx) : index;
    const before = await index.get(key);
    const post = await newsApi.getPost(key);
    if (!post) {
      await removeAll(p);
      await writeIndex.remove(key);
      return dependentPages(before ? membershipOfEntry(before) : null, null);
    }
    // The output path always uses the requested key; a News API key that differs other than by
    // case (e.g. "..") is skipped, never trusted.
    if (post.key.toLowerCase() !== key.toLowerCase()) {
      console.warn(`[public-site] skipping page post:${key}: the News API returned a different key`);
      return [];
    }
    let related: Awaited<ReturnType<NewsApiClient["related"]>> = [];
    try {
      related = await newsApi.related(key);
    } catch (err) {
      console.error(`[public-site] related posts unavailable for post:${key} ${safeErrorLabel(err)}`);
    }
    const all = await ministries(run);
    // The side column's ministry: matched case-insensitively (News API and NRMS key casing can differ).
    const leadKey = (post.leadMinistryKey ?? post.ministryKeys[0])?.toLowerCase();
    const leadMinistry = (leadKey && all.find((m) => m.key.toLowerCase() === leadKey)) || null;
    let ministryLatest: PostDto[] = [];
    if (related.length === 0 && leadKey) {
      const cache = (run.ministryLatest ??= new Map());
      let fetch = cache.get(leadKey);
      if (!fetch) cache.set(leadKey, (fetch = newsApi.latest("ministries", leadKey, MINISTRY_LATEST_COUNT)));
      try {
        ministryLatest = await fetch;
      } catch (err) {
        console.error(`[public-site] the ministry's latest posts are unavailable for post:${key} ${safeErrorLabel(err)}`);
      }
    }
    await storage.write(pageFiles(p)[0]!, renderReleasePage(post, site, opts, { related, leadMinistry, ministryLatest }));
    const entry = indexEntryOf(key, post);
    if (entry) await writeIndex.put(entry);
    else await writeIndex.remove(key);
    return dependentPages(before ? membershipOfEntry(before) : null, membershipOf(post));
  }

  async function renderCategory(kind: CategoryKind, key: string, opts: PageOptions): Promise<void> {
    const p: PageId = { type: "category", kind, key };
    const [page, feed] = pageFiles(p) as [string, string];
    const feedRef = { href: feedUrl(site, p), title: "" };
    if (kind === "ministries") {
      const m = await newsApi.ministry(key);
      if (!m) return removeAll(p);
      const [minister, latest, f] = await Promise.all([newsApi.minister(key), newsApi.latest(kind, key, LATEST_COUNT), featured(m.topPostKey, m.featurePostKey)]);
      feedRef.title = `${m.name}: latest news`;
      await storage.write(page, renderMinistryPage(m, minister, { ...f, latest }, site, { ...opts, feed: feedRef }));
      await storage.write(feed, renderRssFeed({ title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description: `News from ${m.name}` }, sortNewest([f.top, f.feature, ...latest]), site));
      return;
    }
    const c = await newsApi.category(kind, key);
    if (!c) return removeAll(p);
    const [latest, f] = await Promise.all([newsApi.latest(kind, key, LATEST_COUNT), featured(c.topPostKey, c.featurePostKey)]);
    feedRef.title = `${c.name}: latest news`;
    await storage.write(page, renderCategoryPage(kind, c, { ...f, latest }, site, { ...opts, feed: feedRef }));
    await storage.write(feed, renderRssFeed({ title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description: `News about ${c.name}` }, sortNewest([f.top, f.feature, ...latest]), site));
  }

  async function categoryIds(run: RunCache): Promise<string[]> {
    const ids = new Set<string>();
    for (const m of await ministries(run)) {
      const id = categoryPageId("ministries", m.key);
      if (id) ids.add(id);
    }
    for (const kind of CATEGORY_KINDS) {
      if (kind === "ministries") continue;
      for (const c of await newsApi.categories(kind)) {
        const id = categoryPageId(kind, c.key);
        if (id) ids.add(id);
      }
    }
    for (const token of await index.categories()) ids.add(`category:${token}`);
    return [...ids].sort();
  }

  const builder: SiteBuilder = {
    async renderPage(pageId, opts, run = {}, tx) {
      const p = parsePageId(pageId);
      if (!p) {
        console.warn(`[public-site] skipping unknown page id ${JSON.stringify(pageId)}`);
        return [];
      }
      switch (p.type) {
        case "post":
          return renderPost(p.key, opts, run, tx);
        case "home": {
          const home = await newsApi.home();
          const [f, latest, slides, links, sectors] = await Promise.all([featured(home.topPostKey, home.featurePostKey), newsApi.latestHome(LATEST_COUNT), newsApi.slides(), newsApi.resourceLinks(), sectorsWithLatest()]);
          const feedRef = { href: feedUrl(site, p), title: `${site.name}: latest news` };
          await storage.write("index.html", renderHomePage({ ...f, latest, slides, links, sectors }, site, { ...opts, feed: feedRef }));
          await storage.write("feed.xml", renderRssFeed({ title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description: `The latest news from ${site.name}` }, sortNewest([f.top, f.feature, ...latest]), site));
          return [];
        }
        case "ministries":
          await storage.write(pageFiles(p)[0]!, renderMinistriesPage(await ministries(run), site, opts));
          return [];
        case "category":
          await renderCategory(p.kind, p.key, opts);
          return [];
        case "archive":
          await storage.write(pageFiles(p)[0]!, renderArchiveIndex(await index.months(), site, opts));
          return [];
        case "search":
          await storage.write(pageFiles(p)[0]!, renderSearchPage(await ministries(run), site, opts, deps.searchApiBase ?? ""));
          return [];
        case "archive-month": {
          const posts = await index.inMonth(p.month);
          if (posts.length === 0) await removeAll(p);
          else await storage.write(pageFiles(p)[0]!, renderArchiveMonth(p.month, posts, site, opts));
          return [];
        }
        case "sitemap": {
          const months = await index.months();
          await storage.write("sitemap.xml", renderSitemapIndex([pageUrl(site, { type: "sitemap-pages" }), ...months.map((m) => pageUrl(site, { type: "sitemap-month", month: m.month }))], site));
          return [];
        }
        case "sitemap-month": {
          const posts = await index.inMonth(p.month);
          if (posts.length === 0) await removeAll(p);
          else await storage.write(pageFiles(p)[0]!, renderUrlSet(posts.map((x) => ({ path: pageUrl(site, { type: "post", key: x.key }), lastmod: x.publishDate })), site));
          return [];
        }
        case "sitemap-pages": {
          const paths = [pageUrl(site, { type: "home" }), pageUrl(site, { type: "ministries" }), pageUrl(site, { type: "archive" }), pageUrl(site, { type: "search" }), pageUrl(site, { type: "connect" })];
          for (const id of await categoryIds(run)) paths.push(pageUrl(site, parsePageId(id)!));
          for (const m of await index.months()) paths.push(pageUrl(site, { type: "archive-month", month: m.month }));
          await storage.write(pageFiles(p)[0]!, renderUrlSet(paths.map((path) => ({ path })), site));
          return [];
        }
        case "static":
          await writeStaticPages(storage, site, opts, deps.assetsDir);
          return [];
        case "connect":
          await storage.write(pageFiles(p)[0]!, renderConnectPage(site, opts));
          return [];
      }
    },

    async rebuild(pageIds, opts) {
      const run: RunCache = {};
      const unique = [...new Set(pageIds)];
      const rest = new Set(unique.filter((id) => !id.startsWith("post:")));
      // Post pages first: their dependents (and the index the aggregates read) depend on them.
      for (const id of unique.filter((x) => x.startsWith("post:"))) {
        for (const dep of await builder.renderPage(id, opts, run)) rest.add(dep);
      }
      for (const id of rest) await builder.renderPage(id, opts, run);
    },

    async allPostKeys() {
      const keys = new Set<string>();
      for (const kind of POST_KINDS) for (const k of await newsApi.postKeys(kind)) if (POST_KEY.test(k)) keys.add(k);
      for (const k of await index.keys()) keys.add(k);
      for (const k of await storage.listDirs("releases")) if (POST_KEY.test(k)) keys.add(k);
      return [...keys];
    },

    async aggregatePageIds() {
      const run: RunCache = {};
      const ids = ["static", "home", "ministries", "archive", "search", "sitemap", "sitemap:pages", "connect", ...(await categoryIds(run))];
      for (const m of await index.months()) ids.push(formatPageId({ type: "archive-month", month: m.month }), formatPageId({ type: "sitemap-month", month: m.month }));
      return ids;
    },

    async ministryPageIds() {
      // categoryIds' ministry half, without its sector/theme/tag list fetches.
      const ids = new Set<string>();
      for (const m of await newsApi.ministries()) {
        const id = categoryPageId("ministries", m.key);
        if (id) ids.add(id);
      }
      for (const token of await index.categories()) if (token.startsWith("ministries:")) ids.add(`category:${token}`);
      return [...ids].sort();
    },

    async buildAll(opts) {
      const run: RunCache = {};
      let failures = 0;
      const keys = await builder.allPostKeys();
      for (const key of keys) {
        try {
          await builder.renderPage(`post:${key}`, opts, run);
        } catch (err) {
          failures++;
          console.error(`[public-site] build: skipping post:${key} this run ${safeErrorLabel(err)}`);
        }
      }
      for (const id of await builder.aggregatePageIds()) await builder.renderPage(id, opts, run);
      return { posts: keys.length, failures };
    },
  };
  return builder;
}

/** How many sector `latest` fetches one home render runs at once. */
export const SECTOR_FETCHES = 6;

/** `items.map(fn)` with at most `limit` calls in flight, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function sortNewest(posts: (PostDto | null)[]): PostDto[] {
  const seen = new Set<string>();
  return posts
    .filter((p): p is PostDto => !!p && !seen.has(p.key.toLowerCase()) && !!seen.add(p.key.toLowerCase()))
    .sort((a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime());
}
