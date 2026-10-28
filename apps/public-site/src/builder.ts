import type { DbOrTx } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { GovernmentTermDto, MinistryDto, MinistryProfileDto, PostDto, ResourceLinkDto } from "./dto";
import { renderAtomFeed, renderRssFeed } from "./feeds";
import type { NewsApiClient } from "./news-api-client";
import { currentTerms, isCurrentTerm, isLegacyOnly, legacyHref, termEndExclusive, termOfDay, termsHash, type TermsView } from "./government-terms";
import { renderArchiveIndex, renderArchiveMonth, renderTermPage, renderTermsIndex, termRangeLabel } from "./pages/archive";
import { renderCategoryPage, renderMinistryFactsheetsPage, renderMinistryPage } from "./pages/categories";
import { renderCategoryIndex, SECTOR_INDEX_LATEST, type IndexGroup } from "./pages/category-index";
import { renderConnectPage } from "./pages/connect";
import { renderContactsPage } from "./pages/contacts";
import { renderLivePage } from "./pages/live";
import { renderPrivacyPage } from "./pages/privacy";
import { LATEST_COUNT, monthName, sortNewest } from "./pages/format";
import { renderHomePage } from "./pages/home";
import { renderKindListing } from "./pages/listing";
import { hasBiography, renderBiographyPage } from "./pages/minister";
import { renderReleasePage } from "./pages/release";
import { renderSearchPage } from "./pages/search";
import { renderHtmlSitemap, type SitemapGroup } from "./pages/sitemap-html";
import { indexEntryOf, leadMinistryOf, membershipOfEntry, postIndex, type PostIndex } from "./post-index";
import { dependentPages, membershipOf, type Membership } from "./rebuild-set";
import { basePath, type PageOptions, type SiteInfo } from "./render";
import { atomUrl, biographyUrl, categoryFiles, factsheetsUrl, categoryPageId, CATEGORY_KINDS, FEED_POST_KINDS, feedUrl, LISTING_KINDS, kindFeedFile, kindFeedUrl, formatPageId, INDEX_KINDS, LONG_POST_DIR, LONG_POST_KEY_FILE, pageFiles, pageUrl, parsePageId, postDir, sitemapHtmlUrl, postKeyFile, POST_KEY, SHORT_POST_KEY_MAX, TERM_SLUG, type CategoryKind, type ListingKind, type PageId } from "./site-paths";
import { liveJson, liveStreamUrl, settingsHref, themeDefaults } from "./settings";
import { renderSitemapIndex, renderUrlSet } from "./sitemaps";
import { writeStaticPages } from "./static-pages";
import type { SiteStorage } from "./storage";

/** The News API's post kinds (packages/events postKindSchema). */
export const POST_KINDS = ["releases", "stories", "factsheets", "updates", "advisories"] as const;

/** Per-run memo, so a run rendering many pages fetches the ministry list once. */
export interface RunCache {
  ministries?: Promise<MinistryDto[]>;
  /** The government-terms snapshot, once fetched in this run. */
  governmentTerms?: TermsView;
  /** NG-R18: a terms fetch failed in this run (one drain), so the rest of the run uses the
   * degraded view without fetching again. Never kept across runs: the next drain retries. */
  termsOutage?: TermsView;
  /** This run already compared the fetched snapshot with site_state's applied hash. */
  termsHashChecked?: boolean;
  profiles?: Promise<MinistryProfileDto[]>;
  /** Ministry successors (old key → active key), fetched only when a release's lead ministry is
   * inactive; a failure is logged once per run and read as none. */
  successors?: Promise<Record<string, string>>;
  /** Each lead ministry's latest posts (lower-cased key), the release page's related-band
   * fallback: fetched at most once per run, and only by a post with no related posts. */
  ministryLatest?: Map<string, Promise<PostDto[]>>;
  /** The home top and feature posts (the News API's latest lists leave them out), fetched once per run: every kind listing and feed adds back the ones of its kind. Forgotten if the fetch fails. */
  homeFeatured?: Promise<{ top: PostDto | null; feature: PostDto | null }>;
  /** The Resources box's links, fetched once per run for every page that shows them. Forgotten if the fetch fails. */
  resourceLinks?: Promise<ResourceLinkDto[]>;
}

/**
 * `run[key]`, fetched on first use. A rejected fetch is forgotten, so a transient failure fails
 * only the pages already waiting on it and the run's next page fetches again (the queue retries
 * the failed ones).
 */
function runMemo<K extends "homeFeatured" | "resourceLinks">(run: RunCache, key: K, fetch: () => NonNullable<RunCache[K]>): NonNullable<RunCache[K]> {
  const held = run[key];
  if (held) return held as NonNullable<RunCache[K]>;
  const p = fetch();
  run[key] = p;
  p.catch(() => {
    if (run[key] === p) delete run[key];
  });
  return p;
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
  /** Every sector, theme and tag page id — what a `resource_links` change or a `connect` settings
   * change rebuilds (their pages carry the Resources box and the Connect strip). */
  categoryListingPageIds(): Promise<string[]>;
  /** The terms index, the `current` alias and every public term's page — what a
   * `government_terms` change rebuilds (new-government spec §3). */
  termPageIds(): Promise<string[]>;
}

export function createSiteBuilder(deps: { newsApi: NewsApiClient; storage: SiteStorage; index: PostIndex; site: SiteInfo; assetsDir: string | null; searchApiBase?: string }): SiteBuilder {
  const { newsApi, storage, index, site } = deps;
  const ministries = (run: RunCache) => (run.ministries ??= newsApi.ministries());
  const resourceLinks = (run: RunCache) => runMemo(run, "resourceLinks", () => newsApi.resourceLinks());
  /** Never rejects (NG-R18): a terms outage degrades to the last applied snapshot, else none. */
  const governmentTerms = async (run: RunCache): Promise<TermsView> => {
    if (run.governmentTerms) return run.governmentTerms;
    if (run.termsOutage) return run.termsOutage;
    const view = await currentTerms(newsApi, storage);
    if (view.fresh) run.governmentTerms = view;
    else run.termsOutage = view;
    return view;
  };
  /** Term pages (and the term-only pages that render nothing useful without a snapshot) refuse to
   * render with no terms at all during an outage, so the last good page stays until a retry. */
  const requireTerms = async (run: RunCache): Promise<TermsView> => {
    const view = await governmentTerms(run);
    if (!view.fresh && !view.dto) throw new Error("government terms unavailable and none applied yet");
    return view;
  };
  /**
   * NG-R18, durable: a fetched snapshot whose hash differs from site_state's applied hash (a
   * terms change, a first deploy, or an outage that rendered without terms) adds every term page
   * and the pages sitemap to this render's dependents, and records the hash through `idx`, i.e.
   * in the same transaction that enqueues those dependents. A rolled-back drain item leaves the
   * old hash, so the next run notices again. Checked once per run.
   */
  const termsChangePages = async (run: RunCache, idx: PostIndex): Promise<string[]> => {
    const view = run.governmentTerms;
    if (!view?.fresh || run.termsHashChecked) return [];
    run.termsHashChecked = true;
    const hash = termsHash(view.dto);
    if ((await idx.appliedTermsHash()) === hash) return [];
    await idx.setAppliedTermsHash(hash);
    return [...termIdsFor(view, await storage.listDirs("archive/terms")), "sitemap:pages"];
  };
  /** The index, the alias, every term in the view and every term directory on disk. */
  const termIdsFor = (view: TermsView, dirs: string[]): string[] => {
    const slugs = new Set((view.dto?.terms ?? []).map((t) => t.slug));
    for (const dir of dirs) if (TERM_SLUG.test(dir) && dir !== "current") slugs.add(dir);
    return ["archive-terms", "archive-term:current", ...[...slugs].map((slug) => formatPageId({ type: "archive-term", slug }))];
  };
  /** Each public term (newest first) with its post count on this site. */
  const termRows = async (view: TermsView) => {
    const rows = [];
    for (const term of view.dto?.terms ?? []) rows.push({ term, count: await index.countInDayRange(term.startDate, termEndExclusive(term)) });
    return rows;
  };
  // Profiles (minister email, team links) only add to a ministry's pages: a failed fetch is logged
  // once per run and read as none, never failing the render.
  const profiles = (run: RunCache) =>
    (run.profiles ??= newsApi.ministryProfiles().catch((err: unknown) => {
      console.error(`[public-site] ministry profiles unavailable this run; minister emails are left out ${safeErrorLabel(err)}`);
      return [];
    }));
  const successors = (run: RunCache) =>
    (run.successors ??= newsApi.ministrySuccessors().catch((err: unknown): Record<string, string> => {
      console.error(`[public-site] ministry successors unavailable this run; inactive lead ministries are left unlinked ${safeErrorLabel(err)}`);
      return {};
    }));
  const removeAll = async (p: PageId) => {
    for (const f of pageFiles(p)) await storage.remove(f);
  };
  const featured = async (top: string | null, feature: string | null) => {
    const found = await newsApi.postsByKeys([top, feature].filter((k): k is string => !!k));
    const pick = (k: string | null) => (k ? (found.find((p) => p.key.toLowerCase() === k.toLowerCase()) ?? null) : null);
    const t = pick(top);
    const f = pick(feature);
    // The same post in both slots shows once.
    return { top: t, feature: f && t && f.key.toLowerCase() === t.key.toLowerCase() ? null : f };
  };

  /**
   * A kind's newest posts: the News API's latest-of-kind list plus the home top and feature posts
   * when they are of that kind (its latest lists leave them out), newest first, no duplicates. The
   * one merge behind both the kind listings and the kind feeds.
   */
  async function kindPosts(run: RunCache, kind: ListingKind): Promise<PostDto[]> {
    const homeFeatured = runMemo(run, "homeFeatured", () => newsApi.home().then((home) => featured(home.topPostKey, home.featurePostKey)));
    const [f, latest] = await Promise.all([homeFeatured, newsApi.latestOfKind(kind, LATEST_COUNT)]);
    return sortNewest([...[f.top, f.feature].filter((x) => x?.kind === kind), ...latest]);
  }

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

  /**
   * One index page's groups (M8, M16) from one `categoryLatest` call (P4-R11), whatever the number
   * of categories: the active categories in the News API's order (sort order, then key), each with
   * its newest posts (three for a sector, else one) and, except for sectors, its top and feature
   * posts. A key that can't be a page is left out. A failed call rejects, so the queue retries the
   * render and the page stays as it was.
   */
  async function indexGroups(kind: CategoryKind): Promise<IndexGroup[]> {
    const groups = await newsApi.categoryLatest(kind, kind === "sectors" ? SECTOR_INDEX_LATEST : 1);
    return groups.flatMap((g) => {
      if (!categoryPageId(kind, g.key)) return [];
      // Sectors show only their latest posts.
      const top = kind === "sectors" ? null : g.topPost;
      const feature = kind === "sectors" ? null : g.featurePost;
      // The same post in both slots shows once.
      return [{ key: g.key.toLowerCase(), name: g.name, top, feature: feature && top && feature.key.toLowerCase() === top.key.toLowerCase() ? null : feature, latest: g.latest }];
    });
  }

  async function renderPost(key: string, opts: PageOptions, run: RunCache, tx?: DbOrTx): Promise<string[]> {
    const p: PageId = { type: "post", key };
    // The write below goes through `tx` when the caller gave one (M1), so a transaction that
    // fails after this point rolls the write back too — the next attempt's own `index.get`
    // then reads the same `before` this attempt did, not a half-applied one.
    const writeIndex = tx ? postIndex(tx) : index;
    const before = await index.get(key);
    const post = await newsApi.getPost(key);
    const terms = await governmentTerms(run);
    const termOf = termOfDay(terms.dto);
    // Rendered without any terms: whatever snapshot comes next must re-queue every term page.
    if (!terms.fresh && !terms.dto) await writeIndex.setAppliedTermsHash(null);
    /** Spec §3's post row, plus (NG-R18) the alias when no terms are known during an outage, the
     * pages sitemap when a legacy term gains its first post or loses its last (F4), and every
     * term page after an outage. */
    const dependents = async (b: Membership | null, a: Membership | null): Promise<string[]> => {
      const ids = new Set(dependentPages(b, a, termOf));
      if (!terms.fresh && !terms.dto && (b || a)) ids.add("archive-term:current");
      const bt = b ? termOf(b.day)?.slug : undefined;
      const at = a ? termOf(a.day)?.slug : undefined;
      if (bt !== at) {
        for (const [slug, gained] of [[bt, false], [at, true]] as const) {
          const term = slug ? terms.dto?.terms.find((t) => t.slug === slug) : undefined;
          if (!term || isCurrentTerm(term) || !legacyHref(term)) continue;
          const n = await writeIndex.countInDayRange(term.startDate, termEndExclusive(term));
          if (n === (gained ? 1 : 0)) ids.add("sitemap:pages");
        }
      }
      for (const id of await termsChangePages(run, writeIndex)) ids.add(id);
      return [...ids].sort();
    };
    if (!post) {
      await removeAll(p);
      await writeIndex.remove(key);
      return dependents(before ? membershipOfEntry(before) : null, null);
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
    const leadKey = leadMinistryOf(post);
    const leadMinistry = (leadKey && all.find((m) => m.key.toLowerCase() === leadKey)) || null;
    const leadMinistrySuccessor = leadMinistry && !leadMinistry.isActive ? ((await successors(run))[leadMinistry.key.toLowerCase()] ?? null) : null;
    let ministryLatest: PostDto[] = [];
    if (related.length === 0 && leadKey) {
      const cache = (run.ministryLatest ??= new Map());
      let fetch = cache.get(leadKey);
      if (!fetch) {
        // Logged once per ministry per run (the failed promise is cached), read as none.
        fetch = newsApi.latest("ministries", leadKey, MINISTRY_LATEST_COUNT).catch((err: unknown): PostDto[] => {
          console.error(`[public-site] the latest posts of ministry:${leadKey} are unavailable this run (first needed by post:${key}) ${safeErrorLabel(err)}`);
          return [];
        });
        cache.set(leadKey, fetch);
      }
      ministryLatest = await fetch;
    }
    // A long key's directory name is a hash: record the key beside the page so allPostKeys can list
    // it. The sidecar goes first so a failed page write never leaves a page allPostKeys can't see.
    const keyFile = postKeyFile(key);
    if (keyFile) await storage.write(keyFile, `${key}\n`);
    await storage.write(pageFiles(p)[0]!, renderReleasePage(post, site, opts, { related, leadMinistry, leadMinistrySuccessor, ministryLatest }));
    const entry = indexEntryOf(key, post);
    if (entry) await writeIndex.put(entry);
    else await writeIndex.remove(key);
    return dependents(before ? membershipOfEntry(before) : null, membershipOf(post));
  }

  /** Removes a ministry's sub-page (biography, factsheets) and its then-empty folder. */
  const removeSubPage = async (file: string) => {
    await storage.remove(file);
    await storage.removeEmptyDir(file.slice(0, file.lastIndexOf("/")));
  };

  /** Returns `sitemap:pages` when the biography page appeared or went (it lists the bio pages on disk). */
  async function renderCategory(kind: CategoryKind, key: string, opts: PageOptions, run: RunCache): Promise<string[]> {
    const p: PageId = { type: "category", kind, key };
    const { page, feed, atom, bio, factsheets } = categoryFiles({ kind, key });
    const feedRef = { href: feedUrl(site, p), title: "" };
    const feedChannel = (description: string) => ({ title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description });
    const writeFeeds = async (description: string, posts: PostDto[]) => {
      await storage.write(feed, renderRssFeed(feedChannel(description), posts, site));
      await storage.write(atom, renderAtomFeed({ ...feedChannel(description), feedPath: atomUrl(site, p) }, posts, site));
    };
    if (kind === "ministries") {
      const hadBio = await storage.exists(bio!);
      const bioChanged = (has: boolean) => (has === hadBio ? [] : ["sitemap:pages"]);
      const m = await newsApi.ministry(key);
      if (!m) {
        await removeAll(p);
        await removeSubPage(bio!);
        await removeSubPage(factsheets!);
        return bioChanged(false);
      }
      // The factsheets fetch runs with the others, not after them.
      const [minister, latest, factsheetPosts, f, all] = await Promise.all([
        newsApi.minister(key),
        newsApi.latest(kind, key, LATEST_COUNT),
        newsApi.latest(kind, key, LATEST_COUNT, { postKind: "factsheets" }),
        featured(m.topPostKey, m.featurePostKey),
        profiles(run),
      ]);
      const profileOf = (k: string) => all.find((x) => x.key.toLowerCase() === k.toLowerCase()) ?? null;
      const profile = profileOf(key);
      // The ministries of state under this one (legacy MinisterOfState): a child that no longer
      // exists is skipped; a failed fetch rejects the render, as the parent's own fetches do.
      const children = (
        await Promise.all(
          // Only keys that can be a ministry page id (lower-cased, CATEGORY_KEY): anything else would be a broken link.
          (profile?.childKeys ?? []).flatMap((k) => (categoryPageId("ministries", k) ? [k] : [])).map(async (k) => {
            const [child, childMinister] = await Promise.all([newsApi.ministry(k), newsApi.minister(k)]);
            return child ? { ministry: child, minister: childMinister, profile: profileOf(k) } : null;
          }),
        )
      ).filter((c) => c !== null);
      feedRef.title = `${m.name}: latest news`;
      await storage.write(page, renderMinistryPage(m, minister, { ...f, latest }, site, { ...opts, feed: feedRef }, { profile, children }));
      await writeFeeds(`News from ${m.name}`, sortNewest([f.top, f.feature, ...latest]));
      // The factsheets page (H5) is always written: the ministry's top and feature posts when they are
      // factsheets (the latest list leaves them out), then its factsheets; empty is an empty message.
      const ministryFactsheets = sortNewest([...[f.top, f.feature].filter((x) => x?.kind === "factsheets"), ...factsheetPosts]);
      await storage.write(factsheets!, renderMinistryFactsheetsPage(m, minister, ministryFactsheets, site, opts, { profile, children }));
      // The biography page (H2) exists only while the minister has a bio: one cleared in the Hub
      // loses its page on this render instead of lingering.
      const withBio = !!minister && hasBiography(minister);
      if (withBio) await storage.write(bio!, renderBiographyPage(m, minister, profile, site, opts));
      else await removeSubPage(bio!);
      return bioChanged(withBio);
    }
    const c = await newsApi.category(kind, key);
    if (!c) {
      await removeAll(p);
      return [];
    }
    const [latest, f] = await Promise.all([newsApi.latest(kind, key, LATEST_COUNT), featured(c.topPostKey, c.featurePostKey)]);
    feedRef.title = `${c.name}: latest news`;
    const links = await resourceLinks(run);
    await storage.write(page, renderCategoryPage(kind, c, { ...f, latest }, links, site, { ...opts, feed: feedRef }));
    await writeFeeds(`News about ${c.name}`, sortNewest([f.top, f.feature, ...latest]));
    return [];
  }

  /** /connect/'s RSS Feeds: the site feed, then every active ministry, sector and tag (not themes) by name. */
  async function connectFeeds(run: RunCache): Promise<{ title: string; href: string }[]> {
    const cats: { title: string; href: string }[] = [];
    // A key that isn't a safe page key has no page, so no feed either.
    const add = (kind: CategoryKind, name: string, key: string) => {
      if (categoryPageId(kind, key)) cats.push({ title: name, href: feedUrl(site, { type: "category", kind, key: key.toLowerCase() }) });
    };
    for (const m of await ministries(run)) if (m.isActive) add("ministries", m.name, m.key);
    for (const kind of ["sectors", "tags"] as const) for (const c of await newsApi.categories(kind)) if (c.isActive) add(kind, c.name, c.key);
    cats.sort((a, b) => a.title.localeCompare(b.title, "en"));
    return [{ title: site.name, href: feedUrl(site, { type: "home" }) }, ...cats];
  }

  /** Every ministry page id: the given ministry list's, then any the post index still holds. */
  async function ministryIds(list: Promise<MinistryDto[]>): Promise<string[]> {
    const ids = new Set<string>();
    for (const m of await list) {
      const id = categoryPageId("ministries", m.key);
      if (id) ids.add(id);
    }
    for (const token of await index.categories()) if (token.startsWith("ministries:")) ids.add(`category:${token}`);
    return [...ids].sort();
  }

  /** Every sector, theme and tag page id: the News API's lists, then any the post index still holds. */
  async function listingIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const kind of CATEGORY_KINDS) {
      if (kind === "ministries") continue;
      for (const c of await newsApi.categories(kind)) {
        const id = categoryPageId(kind, c.key);
        if (id) ids.add(id);
      }
    }
    for (const token of await index.categories()) if (!token.startsWith("ministries:")) ids.add(`category:${token}`);
    return [...ids].sort();
  }

  /** Every category page id (the run's ministry list, then the sector, theme and tag ones). */
  async function categoryIds(run: RunCache): Promise<string[]> {
    return [...new Set([...(await ministryIds(ministries(run))), ...(await listingIds())])].sort();
  }

  /**
   * The sitemap's groups (L2), built once per `sitemap:pages` render: the XML urlset takes their
   * paths, the HTML page their names too. A minister's biography is listed while its page is on
   * disk: the signal the XML sitemap already used, which renderCategory re-queues this page on
   * (it writes and removes that page, and a stat is how this render sees its result).
   */
  async function sitemapGroups(run: RunCache, opts: PageOptions): Promise<SitemapGroup[]> {
    const settings = opts.settings ?? themeDefaults(site.theme);
    const nav = settings.navigation;
    const base = basePath(site);
    const link = (name: string, p: PageId) => ({ name, path: pageUrl(site, p) });
    // The Subscribe link is the header's (its text is a setting); the default text otherwise.
    const subscribe = nav.headerLinks.find((l) => settingsHref(l.url, site) === `${base}/subscribe/`)?.text ?? "Subscribe";
    const pages = [
      link("Home", { type: "home" }),
      link("Ministries", { type: "ministries" }),
      link("Sectors", { type: "category-index", kind: "sectors" }),
      link("Themes", { type: "category-index", kind: "themes" }),
      link("Topics", { type: "category-index", kind: "tags" }),
      ...LISTING_KINDS.map((kind) => link(nav.listingTitles[kind], { type: "kind", kind })),
      link(settings.contactsPage.heading, { type: "contacts" }),
      link(nav.liveLabel, { type: "live" }),
      link("Connect", { type: "connect" }),
      { name: subscribe, path: `${base}/subscribe/` },
      link("Search", { type: "search" }),
      link("Privacy", { type: "privacy" }),
      link("Archive", { type: "archive" }),
    ];
    // Names by key; a category only the post index still holds has none, so its key stands in.
    const names = new Map<string, string>();
    for (const m of await ministries(run)) names.set(`ministries:${m.key.toLowerCase()}`, m.name);
    for (const kind of CATEGORY_KINDS) if (kind !== "ministries") for (const c of await newsApi.categories(kind)) names.set(`${kind}:${c.key.toLowerCase()}`, c.name);
    const byKind: Record<CategoryKind, { name: string; entries: { name: string; path: string }[] }[]> = { ministries: [], sectors: [], themes: [], tags: [] };
    for (const id of await categoryIds(run)) {
      const page = parsePageId(id);
      if (!page || page.type !== "category") continue;
      const name = names.get(`${page.kind}:${page.key}`) ?? page.key;
      const entries = [{ name, path: pageUrl(site, page) }];
      if (page.kind === "ministries") {
        // Every ministry has a factsheets page (written on every render, empty or not).
        const bio = categoryFiles(page).bio;
        if (bio && (await storage.exists(bio))) entries.push({ name: `${name}: Biography`, path: biographyUrl(site, page.key) });
        entries.push({ name: `${name}: Factsheets`, path: factsheetsUrl(site, page.key) });
      }
      byKind[page.kind].push({ name, entries });
    }
    const category = (heading: string, kind: CategoryKind) => ({
      heading,
      entries: byKind[kind].sort((a, b) => a.name.localeCompare(b.name, "en")).flatMap((c) => c.entries),
    });
    // The months newest first (the index's order), then the terms: the entry point and every term page (not the `current` duplicate).
    const archive = [
      link("Archive by government term", { type: "archive-terms" }),
      ...(await index.months()).map((m) => link(monthName(m.month), { type: "archive-month", month: m.month })),
    ];
    for (const { term, count } of await termRows(await requireTerms(run))) {
      if (!isLegacyOnly(term, count)) archive.push(link(term.label ? `${termRangeLabel(term.startDate, term.endDate)}, ${term.label}` : termRangeLabel(term.startDate, term.endDate), { type: "archive-term", slug: term.slug }));
    }
    return [{ heading: "Pages", entries: pages }, category("Ministries", "ministries"), category("Sectors", "sectors"), category("Themes", "themes"), category("Topics", "tags"), { heading: "Archive", entries: archive }];
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
          const [f, latest, slides, links, sectors] = await Promise.all([featured(home.topPostKey, home.featurePostKey), newsApi.latestHome(LATEST_COUNT), newsApi.slides(), resourceLinks(run), sectorsWithLatest()]);
          const feedRef = { href: feedUrl(site, p), title: `${site.name}: latest news` };
          // The Live button's state, beside the page that polls for it (site.js); the flag only.
          await storage.write("assets/live.json", liveJson(home));
          await storage.write("index.html", renderHomePage({ ...f, latest, slides, links, sectors }, site, { ...opts, feed: feedRef }));
          const homePosts = sortNewest([f.top, f.feature, ...latest]);
          const homeChannel = { title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description: `The latest news from ${site.name}` };
          await storage.write("feed.xml", renderRssFeed(homeChannel, homePosts, site));
          await storage.write("atom.xml", renderAtomFeed({ ...homeChannel, feedPath: atomUrl(site, p) }, homePosts, site));
          return [];
        }
        case "kind-feeds": {
          // Each kind's posts come from kindPosts (the home top and feature posts added back when
          // they are of the kind). Home, the featured posts and one list per kind, all fetched
          // before any file is written: a failed fetch leaves every feed as it was.
          // The channel link is the home page.
          const all = await Promise.all(FEED_POST_KINDS.map((kind) => kindPosts(run, kind)));
          for (const [i, kind] of FEED_POST_KINDS.entries()) {
            const posts = all[i]!;
            const rss = { title: `${site.name}: ${kind}`, pagePath: pageUrl(site, p), feedPath: kindFeedUrl(site, kind, "rss"), description: `The latest ${kind} from ${site.name}` };
            await storage.write(kindFeedFile(kind, "rss"), renderRssFeed(rss, posts, site));
            await storage.write(kindFeedFile(kind, "atom"), renderAtomFeed({ ...rss, feedPath: kindFeedUrl(site, kind, "atom") }, posts, site));
          }
          return [];
        }
        case "kind": {
          // Everything is fetched before the write: a failed fetch leaves the page as it was.
          const [posts, links] = await Promise.all([kindPosts(run, p.kind), resourceLinks(run)]);
          const settings = opts.settings ?? themeDefaults(site.theme);
          await storage.write(pageFiles(p)[0]!, renderKindListing(p.kind, settings.navigation.listingTitles[p.kind], posts, links, site, opts));
          return [];
        }
        case "ministries":
        case "category-index": {
          const kind = p.type === "ministries" ? "ministries" : p.kind;
          // Everything is fetched before the write: a failed fetch leaves the page as it was.
          const [groups, links] = await Promise.all([indexGroups(kind), resourceLinks(run)]);
          await storage.write(pageFiles(p)[0]!, renderCategoryIndex(kind, groups, links, site, opts));
          return [];
        }
        case "category":
          return renderCategory(p.kind, p.key, opts, run);
        case "archive":
          await storage.write(pageFiles(p)[0]!, renderArchiveIndex(await index.months(), site, opts));
          return [];
        case "archive-terms":
          await storage.write(pageFiles(p)[0]!, renderTermsIndex(await termRows(await requireTerms(run)), site, opts));
          return termsChangePages(run, tx ? postIndex(tx) : index);
        case "archive-term": {
          // `current` is a static duplicate of the current term's page, canonical to the slug page (N6).
          const view = await requireTerms(run);
          const slug = p.slug === "current" ? view.dto?.currentSlug : p.slug;
          const term: GovernmentTermDto | undefined = view.dto?.terms.find((t) => t.slug === slug);
          const end = term ? termEndExclusive(term) : null;
          if (!term || isLegacyOnly(term, await index.countInDayRange(term.startDate, end))) {
            // Only on a fetched snapshot: a stale one must not delete a page the live one still has.
            if (view.fresh) await removeAll(p);
            return termsChangePages(run, tx ? postIndex(tx) : index);
          }
          await storage.write(pageFiles(p)[0]!, renderTermPage(term, await index.inDayRange(term.startDate, end), site, { ...opts, canonicalSlug: term.slug }));
          return termsChangePages(run, tx ? postIndex(tx) : index);
        }
        case "search": {
          // The filter panel's lists: every active ministry and sector, and the public terms (an
          // outage keeps the last applied snapshot, else none: the Date list then has only the
          // date range and the older-archive links).
          const [ministryList, sectors, terms] = await Promise.all([ministries(run), newsApi.categories("sectors"), governmentTerms(run)]);
          const settings = opts.settings ?? themeDefaults(site.theme);
          await storage.write(pageFiles(p)[0]!, renderSearchPage({ ministries: ministryList, sectors, terms: terms.dto?.terms ?? [] }, settings.pageText.searchArchiveLinks, site, opts, deps.searchApiBase ?? ""));
          return [];
        }
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
          const groups = await sitemapGroups(run, opts);
          // Search and Subscribe are in the HTML sitemap for people, not the XML: robots.txt
          // disallows them, and Search Console flags sitemap URLs blocked by robots. The XML adds
          // /sitemap/ itself, so crawlers find it.
          const blocked = new Set([pageUrl(site, { type: "search" }), `${basePath(site)}/subscribe/`]);
          const paths = [...groups.flatMap((g) => g.entries.map((x) => x.path)).filter((x) => !blocked.has(x)), sitemapHtmlUrl(site)];
          await storage.write("sitemaps/pages.xml", renderUrlSet(paths.map((path) => ({ path })), site));
          await storage.write("sitemap/index.html", renderHtmlSitemap(groups, site, opts));
          return [];
        }
        case "static":
          await writeStaticPages(storage, site, opts, deps.assetsDir);
          return [];
        case "connect":
          await storage.write(pageFiles(p)[0]!, renderConnectPage(site, opts, await connectFeeds(run), await resourceLinks(run)));
          return [];
        case "contacts":
          await storage.write(pageFiles(p)[0]!, renderContactsPage(await ministries(run), (opts.settings ?? themeDefaults(site.theme)).contactsPage, site, opts));
          return [];
        case "privacy":
          await storage.write(pageFiles(p)[0]!, renderPrivacyPage((opts.settings ?? themeDefaults(site.theme)).pageText.privacy, site, opts));
          return [];
        case "live": {
          const home = await newsApi.home();
          await storage.write("assets/live.json", liveJson(home));
          await storage.write(pageFiles(p)[0]!, renderLivePage(liveStreamUrl(home), (opts.settings ?? themeDefaults(site.theme)).pageText.live, site, opts));
          return [];
        }
        case "legacy-redirects": {
          // Sorted, so an unchanged map writes the same bytes.
          const successors = Object.fromEntries(Object.entries(await newsApi.ministrySuccessors()).sort(([a], [b]) => (a < b ? -1 : 1)));
          await storage.write(pageFiles(p)[0]!, `${JSON.stringify({ successors })}\n`);
          return [];
        }
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
      // An aggregate's own dependents (a ministry page whose bio appeared → sitemap:pages) once more.
      const again = new Set<string>();
      for (const id of rest) for (const dep of await builder.renderPage(id, opts, run)) again.add(dep);
      for (const id of again) await builder.renderPage(id, opts, run);
    },

    async allPostKeys() {
      const keys = new Set<string>();
      for (const kind of POST_KINDS) for (const k of await newsApi.postKeys(kind)) if (POST_KEY.test(k)) keys.add(k);
      for (const k of await index.keys()) keys.add(k);
      for (const k of await storage.listDirs("releases")) if (POST_KEY.test(k)) keys.add(k);
      // Keys over 100 characters sit in hashed directories; the sidecar names the key. Trusted only
      // when it is a long key whose own hash is that directory.
      for (const h of await storage.listDirs(LONG_POST_DIR)) {
        const k = (await storage.read(`${LONG_POST_DIR}/${h}/${LONG_POST_KEY_FILE}`))?.trim();
        if (k && k.length > SHORT_POST_KEY_MAX && POST_KEY.test(k) && postDir(k) === `${LONG_POST_DIR}/${h}`) keys.add(k);
      }
      return [...keys];
    },

    async aggregatePageIds() {
      const run: RunCache = {};
      // sitemap:pages after the category pages: it lists the biography pages they write.
      const ids = ["static", "home", "ministries", "archive", "search", "sitemap", "connect", "contacts", "privacy", "live", "legacy-redirects", "kind-feeds", ...INDEX_KINDS.map((k) => `index:${k}`), ...LISTING_KINDS.map((k) => `kind:${k}`), ...(await categoryIds(run)), "sitemap:pages"];
      for (const m of await index.months()) ids.push(formatPageId({ type: "archive-month", month: m.month }), formatPageId({ type: "sitemap-month", month: m.month }));
      ids.push(...(await builder.termPageIds()));
      return ids;
    },

    async ministryPageIds() {
      // categoryIds' ministry half, without its sector/theme/tag list fetches.
      return ministryIds(newsApi.ministries());
    },

    async categoryListingPageIds() {
      return listingIds();
    },

    async termPageIds() {
      // Never rejects (NG-R18): during an outage, the last applied terms, else just the index and
      // the alias. Term directories already on disk are listed too, so a term that has left the
      // payload is rendered once more, which removes it (F5).
      return termIdsFor(await currentTerms(newsApi, storage), await storage.listDirs("archive/terms"));
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
      const again = new Set<string>();
      for (const id of await builder.aggregatePageIds()) for (const dep of await builder.renderPage(id, opts, run)) again.add(dep);
      for (const id of again) await builder.renderPage(id, opts, run);
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
