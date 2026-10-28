import { JSDOM } from "jsdom";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, ministry, post, site } from "../test/fixtures";
import { createSiteBuilder, SECTOR_FETCHES } from "./builder";
import type { GovernmentTermDto, GovernmentTermsDto, PostDto } from "./dto";
import { drainQueue } from "./drain";
import { postIndex } from "./post-index";
import { enqueuePages } from "./queue";
import { rebuildAllItems } from "./rebuild-all";

describe("site builder", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts, site_state"); });

  const setup = (posts: Map<string, PostDto>) => {
    const storage = memoryStorage();
    const api = fakeNewsApi(posts);
    const builder = createSiteBuilder({ newsApi: api, storage, index: postIndex(tdb.db), site, assetsDir: null });
    return { storage, api, builder };
  };
  const html = (s: ReturnType<typeof memoryStorage>, path: string) => String(s.files.get(path) ?? "");

  it("a published post: its page, then home, ministry, tag, month archive, archive index and sitemaps", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1", ministryKeys: ["Health"], tagKeys: ["covid-19"] })]]));
    await builder.rebuild(["home", "post:K1"], {});
    for (const f of ["releases/K1/index.html", "index.html", "feed.xml", "ministries/health/index.html", "ministries/health/feed.xml", "tags/covid-19/index.html", "archive/index.html", "archive/2026/10/index.html", "sitemap.xml", "sitemaps/2026-10.xml"]) {
      expect(storage.files.has(f), f).toBe(true);
    }
    expect(html(storage, "ministries/health/index.html")).toContain('href="/releases/K1/"');
    expect(html(storage, "archive/2026/10/index.html")).toContain('href="/releases/K1/"');
    expect(html(storage, "sitemaps/2026-10.xml")).toContain("https://news.example/releases/K1/");
  });

  it("a ministry render writes ministries/<k>/atom.xml", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1", ministryKeys: ["Health"] })]]));
    await builder.rebuild(["home", "category:ministries:health", "category:tags:covid-19"], {});
    for (const f of ["atom.xml", "ministries/health/atom.xml", "tags/covid-19/atom.xml"]) expect(storage.files.has(f), f).toBe(true);
    expect(html(storage, "ministries/health/atom.xml")).toContain("<id>https://news.example/releases/K1/</id>");
    expect(html(storage, "ministries/health/atom.xml")).toContain("https://news.example/ministries/health/atom.xml");
  });

  it("the factsheets feed holds only factsheets and includes a factsheet that is the home top post", async () => {
    const posts = new Map([
      ["F1", post({ key: "F1", kind: "factsheets", publishDate: "2026-10-01T10:00:00-07:00" })],
      ["F2", post({ key: "F2", kind: "factsheets", publishDate: "2026-10-02T10:00:00-07:00" })],
      ["R1", post({ key: "R1", kind: "releases", publishDate: "2026-10-03T10:00:00-07:00" })],
    ]);
    const { storage, api, builder } = setup(posts);
    api.home = async () => ({ granville: null, topPostKey: "F1", featurePostKey: null });
    // The real API's latest list leaves out the home top post.
    const latestOfKind = api.latestOfKind;
    api.latestOfKind = async (k, n) => (await latestOfKind(k, n)).filter((p) => p.key !== "F1");
    await builder.rebuild(["kind-feeds"], {});
    for (const f of ["feeds/releases.xml", "feeds/releases.atom.xml", "feeds/stories.xml", "feeds/updates.atom.xml"]) expect(storage.files.has(f), f).toBe(true);
    for (const f of ["feeds/factsheets.xml", "feeds/factsheets.atom.xml"]) {
      expect(html(storage, f), f).toContain("/releases/F1/");
      expect(html(storage, f), f).toContain("/releases/F2/");
      expect(html(storage, f), f).not.toContain("/releases/R1/");
    }
    expect(html(storage, "feeds/releases.xml")).not.toContain("/releases/F1/");
    expect(html(storage, "feeds/factsheets.atom.xml")).toContain("https://news.example/feeds/factsheets.atom.xml");
  });

  it("kind-feeds is all-or-nothing: one kind's failed fetch writes no feed file", async () => {
    const { storage, api, builder } = setup(new Map([["R1", post({ key: "R1", kind: "releases" })]]));
    const latestOfKind = api.latestOfKind;
    api.latestOfKind = async (k, n) => {
      if (k === "updates") throw new Error("api down");
      return latestOfKind(k, n);
    };
    await expect(builder.rebuild(["kind-feeds"], {})).rejects.toThrow();
    expect([...storage.files.keys()].filter((f) => f.startsWith("feeds/"))).toEqual([]);
  });

  it("the sitemap pages list no feed files", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    await builder.rebuild(["home", "kind-feeds", "category:ministries:health", "sitemap:pages"], {});
    expect(html(storage, "sitemaps/pages.xml")).not.toMatch(/\.xml<|atom|feed/);
  });

  it("aggregatePageIds includes kind-feeds", async () => {
    const { builder } = setup(new Map());
    expect(await builder.aggregatePageIds()).toContain("kind-feeds");
  });

  it("home: News by Sector lists the active sectors by name, each with its latest post; a sector with none is left out", async () => {
    const posts = new Map([
      ["K1", post({ key: "K1", sectorKeys: ["economy"], documents: [{ languageId: 4105, headline: "Economy headline", subheadline: null, detailsHtml: null, contacts: [] }] })],
      ["K2", post({ key: "K2", sectorKeys: ["agriculture", "retired"], publishDate: "2026-10-04T10:00:00-07:00", documents: [{ languageId: 4105, headline: "Farm headline", subheadline: null, detailsHtml: null, contacts: [] }] })],
    ]);
    const { storage, api, builder } = setup(posts);
    const sector = (key: string, name: string, isActive = true) => ({ key, kind: "sectors", name, isActive, topPostKey: null, featurePostKey: null });
    api.sectors = [sector("economy", "Economy"), sector("retired", "Retired sector", false), sector("agriculture", "Agriculture"), sector("empty", "Empty")];
    await builder.rebuild(["home"], { settings: bcSettings() });
    const page = html(storage, "index.html");
    const box = page.slice(page.indexOf("News by Sector"));
    expect(box.indexOf("Agriculture")).toBeGreaterThan(0);
    expect(box.indexOf("Agriculture")).toBeLessThan(box.indexOf("Economy"));
    expect(box).toContain('<a href="/releases/K2/">Farm headline</a>');
    expect(box).toContain('<a href="/releases/K1/">Economy headline</a>');
    expect(page).not.toContain("Retired sector");
    expect(page).not.toContain(">Empty<");
  });

  it("home: a sector whose latest fetch fails is left out (logged) and the page still renders; fetches run at most SECTOR_FETCHES at once", async () => {
    const posts = new Map([["K1", post({ key: "K1", sectorKeys: ["economy", "broken"], documents: [{ languageId: 4105, headline: "Economy headline", subheadline: null, detailsHtml: null, contacts: [] }] })]]);
    const { storage, api, builder } = setup(posts);
    const sector = (key: string, name: string) => ({ key, kind: "sectors", name, isActive: true, topPostKey: null, featurePostKey: null });
    api.sectors = [sector("economy", "Economy"), sector("broken", "Broken"), ...Array.from({ length: 12 }, (_, i) => sector(`s${i}`, `Sector ${i}`))];
    const latest = api.latest;
    let inFlight = 0;
    let peak = 0;
    api.latest = async (kind, key, n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (key === "broken") throw new Error("News API 500");
      return latest(kind, key, n);
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await builder.rebuild(["home"], {});
    const page = html(storage, "index.html");
    expect(page).toContain("News by Sector");
    expect(page).toContain('<a href="/releases/K1/">Economy headline</a>');
    expect(page).not.toContain(">Broken<");
    expect(error.mock.calls.flat().join(" ")).toContain("sector:broken");
    expect(peak).toBeLessThanOrEqual(SECTOR_FETCHES);
    expect(peak).toBeGreaterThan(1);

    // The sector list itself failing: the box is left out, home still renders.
    api.categories = async () => { throw new Error("News API down"); };
    await builder.rebuild(["home"], {});
    expect(html(storage, "index.html")).not.toContain("News by Sector");
    expect(html(storage, "index.html")).toContain("Latest news");
    error.mockRestore();
  });

  it("every home render writes assets/live.json with only the flag: true for an https playlist, false for none or an unsafe one", async () => {
    const { storage, api, builder } = setup(new Map());
    await builder.rebuild(["home"], {});
    expect(html(storage, "assets/live.json")).toBe('{"live":false}');
    api.home = async () => ({ granville: null, topPostKey: null, featurePostKey: null, liveWebcastM3uPlaylist: "https://stream.example/secret/live.m3u8" });
    await builder.rebuild(["home"], {});
    expect(html(storage, "assets/live.json")).toBe('{"live":true}');
    expect(html(storage, "index.html")).not.toContain("stream.example");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    api.home = async () => ({ granville: null, topPostKey: null, featurePostKey: null, liveWebcastM3uPlaylist: "http://stream.example/live.m3u8" });
    await builder.rebuild(["home"], {});
    err.mockRestore();
    expect(html(storage, "assets/live.json")).toBe('{"live":false}');
  });

  it("an update that moves a post to another ministry takes it off the old ministry page", async () => {
    const posts = new Map([["K1", post({ key: "K1", ministryKeys: ["health"] })]]);
    const { storage, builder } = setup(posts);
    await builder.rebuild(["post:K1"], {});
    posts.set("K1", post({ key: "K1", ministryKeys: ["finance"], publishDate: "2026-11-02T10:00:00-07:00" }));
    await builder.rebuild(["post:K1"], {});
    expect(html(storage, "ministries/health/index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "ministries/finance/index.html")).toContain("/releases/K1/");
    expect(storage.files.has("archive/2026/10/index.html")).toBe(false);
    expect(html(storage, "archive/2026/11/index.html")).toContain("/releases/K1/");
  });

  it("unpublishing removes the release page and its entries", async () => {
    const posts = new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2", publishDate: "2026-09-01T10:00:00-07:00" })]]);
    const { storage, builder } = setup(posts);
    await builder.rebuild(["post:K1", "post:K2"], {});
    posts.delete("K1");
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
    expect(storage.files.has("archive/2026/10/index.html")).toBe(false);
    expect(storage.files.has("sitemaps/2026-10.xml")).toBe(false);
    expect(html(storage, "archive/index.html")).not.toContain("October 2026");
    expect(html(storage, "index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "ministries/health/index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "sitemap.xml")).not.toContain("2026-10.xml");
  });

  it("renders a post with a 102-char key to the hashed dir, and allPostKeys still lists it", async () => {
    const key = "canada-and-british-columbia-investments-in-local-infrastructure-help-build-community-connections-for-1";
    const posts = new Map([[key, post({ key })], ["K2", post({ key: "K2", publishDate: "2026-09-01T10:00:00-07:00" })]]);
    const { storage, builder } = setup(posts);
    await builder.rebuild([`post:${key}`, "post:K2"], {});
    const dir = "releases/_long/106422386aca9cfd948a818d5a9a92f5";
    expect(storage.files.has(`${dir}/index.html`)).toBe(true);
    expect(storage.files.has(`releases/${key}/index.html`)).toBe(false);
    expect(html(storage, "sitemaps/2026-10.xml")).toContain(`/releases/${key}/`);
    // Listed from disk alone (no News API, no index): the key is recovered from the sidecar.
    const bare = createSiteBuilder({ newsApi: fakeNewsApi(new Map()), storage, index: postIndex(tdb.db), site, assetsDir: null });
    await tdb.pool.query("TRUNCATE site_posts");
    expect((await bare.allPostKeys()).sort()).toEqual([key, "K2"].sort());
    // Unpublishing removes the page and the sidecar, so the key is no longer listed.
    posts.delete(key);
    await builder.rebuild([`post:${key}`], {});
    expect([...storage.files.keys()].filter((f) => f.startsWith("releases/_long/"))).toEqual([]);
    expect(await bare.allPostKeys()).toEqual(["K2"]);
  });

  it("allPostKeys ignores a forged sidecar: wrong hash dir, or a key of 100 characters or fewer", async () => {
    const { storage, builder } = setup(new Map());
    const long = "x".repeat(101);
    await storage.write("releases/_long/00000000000000000000000000000000/.key", `${long}\n`);
    await storage.write("releases/_long/11111111111111111111111111111111/.key", "K1\n");
    const names = [...storage.files.keys()].filter((f) => f.startsWith("releases/_long/"));
    expect(names).toHaveLength(2);
    expect(await builder.allPostKeys()).toEqual([]);
  });

  it("a category the News API no longer has loses its page and feed", async () => {
    const { storage, builder } = setup(new Map());
    await storage.write("tags/gone/index.html", "x");
    await storage.write("tags/gone/feed.xml", "x");
    await storage.write("tags/gone/atom.xml", "x");
    await builder.rebuild(["category:tags:gone"], {});
    expect(storage.files.has("tags/gone/index.html")).toBe(false);
    expect(storage.files.has("tags/gone/feed.xml")).toBe(false);
    expect(storage.files.has("tags/gone/atom.xml")).toBe(false);
  });

  it("a full build lists a biography page written in the same build in sitemaps/pages.xml", async () => {
    const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1", ministryKeys: ["Health"] })]]));
    api.minister = async (key) => (key.toLowerCase() === "health" ? { headline: "Hon. Alex Example", summary: "s", details: "<p>Bio.</p>", photo: null } : null);
    await builder.buildAll({});
    expect(storage.files.has("ministries/health/biography/index.html")).toBe(true);
    expect(html(storage, "sitemaps/pages.xml")).toContain("<loc>https://news.example/ministries/health/biography/</loc>");
  });

  it("writes ministries/<key>/biography/index.html when the minister has details; clearing details removes the file and its folder on the next render", async () => {
    const { storage, api, builder } = setup(new Map());
    const removeEmptyDir = vi.spyOn(storage, "removeEmptyDir");
    const minister = { headline: "Hon. Alex Example", summary: "Minister of Health.", details: "<p>Alex was elected in 2020.</p>", photo: null };
    api.minister = async (key) => (key.toLowerCase() === "health" ? minister : null);
    api.ministryProfiles = async () => [{ key: "Health", ministerEmail: "hlth@gov.example", teamLinks: [], childKeys: [] }];
    // The bio page appearing re-queues sitemaps/pages.xml, which lists it; an unchanged render doesn't.
    expect(await builder.renderPage("category:ministries:health", {})).toEqual(["sitemap:pages"]);
    expect(await builder.renderPage("category:ministries:health", {})).toEqual([]);
    await builder.renderPage("sitemap:pages", {});
    expect(html(storage, "sitemaps/pages.xml")).toContain("<loc>https://news.example/ministries/health/biography/</loc>");
    expect(html(storage, "sitemaps/pages.xml")).not.toContain("/ministries/finance/biography/");
    const bio = html(storage, "ministries/health/biography/index.html");
    expect(bio).toContain("<h1>Hon. Alex Example</h1>");
    expect(bio).toContain("Alex was elected in 2020.");
    expect(bio).toContain('href="mailto:hlth@gov.example"');
    // Cleared in the Hub: the stale bio page goes on the next render, the ministry page stays.
    minister.details = null as unknown as string;
    expect(await builder.renderPage("category:ministries:health", {})).toEqual(["sitemap:pages"]);
    expect(storage.files.has("ministries/health/biography/index.html")).toBe(false);
    expect(removeEmptyDir).toHaveBeenCalledWith("ministries/health/biography");
    expect(storage.files.has("ministries/health/index.html")).toBe(true);
    await builder.renderPage("sitemap:pages", {});
    expect(html(storage, "sitemaps/pages.xml")).not.toContain("/biography/");
    expect(html(storage, "sitemaps/pages.xml")).toContain("<loc>https://news.example/ministries/health/</loc>");
    // A ministry with no minister never gets one; a vanished ministry loses all three files.
    await builder.renderPage("category:ministries:finance", {});
    expect(storage.files.has("ministries/finance/biography/index.html")).toBe(false);
    for (const f of ["ministries/gone/index.html", "ministries/gone/feed.xml", "ministries/gone/biography/index.html"]) await storage.write(f, "x");
    await builder.renderPage("category:ministries:gone", {});
    for (const f of ["ministries/gone/index.html", "ministries/gone/feed.xml", "ministries/gone/biography/index.html"]) expect(storage.files.has(f), f).toBe(false);
  });

  it("renders each childKey's ministry and minister; a null child ministry is skipped", async () => {
    const { storage, api, builder } = setup(new Map());
    const ministries = { health: "Health", finance: "Minister of State for Finance" } as Record<string, string>;
    api.ministry = async (key) => (ministries[key.toLowerCase()] ? ministry({ key: key.toLowerCase(), name: ministries[key.toLowerCase()] }) : null);
    api.minister = async (key) => ({ headline: key.toLowerCase() === "finance" ? "Hon. Sam State" : "Hon. Alex Example", summary: null, details: "<p>Bio.</p>", photo: null });
    api.ministryProfiles = async () => [
      { key: "Health", ministerEmail: null, teamLinks: [], childKeys: ["Finance", "gone", "bad/key", "x?y", ""] },
      { key: "finance", ministerEmail: "fin@gov.example", teamLinks: [], childKeys: [] },
    ];
    const asked: string[] = [];
    const ministryOf = api.ministry;
    api.ministry = async (key) => (asked.push(key), ministryOf(key));
    await builder.renderPage("category:ministries:health", {});
    // A child key that can't be a category page id is never fetched or linked.
    expect(asked.filter((k) => k !== "health")).toEqual(["Finance", "gone"]);
    const page = html(storage, "ministries/health/index.html");
    expect(page).toContain('<h2><a href="/ministries/finance/">Minister of State for Finance</a></h2>');
    expect(page).toContain("<h3>Hon. Sam State</h3>");
    expect(page).toContain('href="/ministries/finance/biography/"');
    expect(page).toContain('href="mailto:fin@gov.example"');
    expect(page.match(/resource-links minister/g)).toHaveLength(2); // Health's own card and the one child; "gone" is skipped
  });

  it("a child ministry fetch failure rejects the page render", async () => {
    const { storage, api, builder } = setup(new Map());
    const original = api.ministry;
    api.ministry = async (key) => (key.toLowerCase() === "finance" ? Promise.reject(new Error("down")) : original(key));
    api.ministryProfiles = async () => [{ key: "health", ministerEmail: null, teamLinks: [], childKeys: ["finance"] }];
    await expect(builder.renderPage("category:ministries:health", {})).rejects.toThrow("down");
    expect(storage.files.has("ministries/health/index.html")).toBe(false);
  });

  it("profile fetch failure: renders the pages without the Contact email (profiles(run) failure is logged, not thrown)", async () => {
    const { storage, api, builder } = setup(new Map());
    api.minister = async () => ({ headline: "Hon. Alex Example", summary: null, details: "Bio text", photo: null });
    api.ministryProfiles = async () => { throw Object.assign(new Error("secret detail"), { code: "ECONNREFUSED" }); };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await builder.rebuild(["category:ministries:health", "category:ministries:finance"], {});
      expect(storage.files.has("ministries/health/index.html")).toBe(true);
      const bio = html(storage, "ministries/health/biography/index.html");
      expect(bio).toContain("<h1>Hon. Alex Example</h1>");
      expect(bio).not.toContain("minister-email");
      expect(bio).not.toContain("mailto:");
      // Logged once for the run (the result is memoised), with the error's safe label.
      const logged = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("ministry profiles"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("ECONNREFUSED");
      expect(logged[0]).not.toContain("secret detail");
    } finally {
      error.mockRestore();
    }
  });

  it("skips (and never writes for) an invalid page id", async () => {
    const { storage, builder } = setup(new Map());
    await builder.rebuild(["post:../../etc", "category:ministries:../x", "bogus"], {});
    expect(storage.files.size).toBe(0);
  });

  it("a News API key that differs from the requested one is skipped, not written", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: ".." })]]));
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
  });

  it("the release page's lead ministry is found case-insensitively by leadMinistryKey, else the first ministryKey", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1", leadMinistryKey: "HEALTH", ministryKeys: ["finance"] })], ["K2", post({ key: "K2", leadMinistryKey: null, ministryKeys: ["Finance"] })], ["K3", post({ key: "K3", leadMinistryKey: "nope" })]]));
    await builder.rebuild(["post:K1", "post:K2", "post:K3"], {});
    expect(html(storage, "releases/K1/index.html")).toContain('<p class="story-ministry"><a href="/ministries/health/">Health</a></p>');
    expect(html(storage, "releases/K1/index.html")).toContain("More from this Ministry");
    expect(html(storage, "releases/K2/index.html")).toContain('<p class="story-ministry"><a href="/ministries/finance/">Finance</a></p>');
    expect(html(storage, "releases/K3/index.html")).not.toContain("story-ministry");
  });

  it("a failing ministry latest-posts fetch (the related band's fallback) is logged once per ministry per run", async () => {
    const posts = new Map([["K1", post({ key: "K1", leadMinistryKey: "health" })], ["K2", post({ key: "K2", leadMinistryKey: "health" })], ["K3", post({ key: "K3", leadMinistryKey: "health" })]]);
    const { storage, api, builder } = setup(posts);
    const latest = api.latest;
    // Only the band's fallback fetch (3 to show + the release itself) fails; the ministry and home pages' own lists still load.
    api.latest = async (kind, key, n) => { if (n === 4) throw new Error("News API 500"); return latest(kind, key, n); };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await builder.rebuild(["post:K1", "post:K2", "post:K3"], {});
    expect(storage.files.has("releases/K3/index.html")).toBe(true);
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("latest posts"))).toHaveLength(1);
    errors.mockRestore();
  });

  it("an inactive lead ministry is linked only when a successor resolves; successors are fetched once per run, only for an inactive lead", async () => {
    const posts = new Map([["K1", post({ key: "K1", leadMinistryKey: "old-health" })], ["K2", post({ key: "K2", leadMinistryKey: "gone" })], ["K3", post({ key: "K3", leadMinistryKey: "health" })]]);
    const { storage, api, builder } = setup(posts);
    api.ministries = async () => [ministry({ key: "health", name: "Health" }), ministry({ key: "old-health", name: "Old Health", isActive: false }), ministry({ key: "gone", name: "Gone", isActive: false })];
    api.successors = { "old-health": "health" };
    await builder.rebuild(["post:K1", "post:K2", "post:K3"], {});
    expect(html(storage, "releases/K1/index.html")).toContain('<p class="story-ministry"><a href="/ministries/old-health/">Old Health</a></p>');
    expect(html(storage, "releases/K2/index.html")).toContain('<p class="story-ministry">Gone</p>');
    expect(api.calls.filter((c) => c === "ministrySuccessors")).toHaveLength(1);

    // A successors outage leaves the inactive ministry unlinked; the page still renders.
    const { storage: s2, api: api2, builder: b2 } = setup(new Map([["K1", post({ key: "K1", leadMinistryKey: "old-health" })]]));
    api2.ministries = api.ministries;
    api2.ministrySuccessors = async () => { throw new Error("News API 500"); };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await b2.rebuild(["post:K1"], {});
    expect(html(s2, "releases/K1/index.html")).toContain('<p class="story-ministry">Old Health</p>');
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("successors"))).toHaveLength(1);
    errors.mockRestore();
  });

  it("a related-posts failure doesn't block the release page", async () => {
    const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    api.related = async () => { throw new Error("News API 500"); };
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
  });

  it("fetches the ministry's latest once per run and only when related is empty; a failure renders the page without a fallback", async () => {
    const posts = new Map([
      ["K1", post({ key: "K1", leadMinistryKey: "Health", ministryKeys: ["health"], publishDate: "2026-10-01T10:00:00-07:00", documents: [{ languageId: 4105, headline: "One", subheadline: null, detailsHtml: null, contacts: [] }] })],
      ["K2", post({ key: "K2", ministryKeys: ["health"], publishDate: "2026-10-02T10:00:00-07:00", documents: [{ languageId: 4105, headline: "Two", subheadline: null, detailsHtml: null, contacts: [] }] })],
      ["K3", post({ key: "K3", ministryKeys: ["finance"], publishDate: "2026-10-03T10:00:00-07:00" })],
    ]);
    const { storage, api, builder } = setup(posts);
    const latest = vi.spyOn(api, "latest");
    const relatedTo = new Map([["K3", [{ key: "K9", headline: "Nine", publishDate: "2026-09-09T09:00:00-07:00" }]]]);
    api.related = async (key) => relatedTo.get(key) ?? [];
    // One run (as rebuild and buildAll share one) rendering the three post pages.
    const run = {};
    for (const k of ["K1", "K2", "K3"]) await builder.renderPage(`post:${k}`, {}, run);
    // K1 and K2 share health's fetch; K3 has v2 related, so finance's latest is never asked for.
    expect(latest.mock.calls).toEqual([["ministries", "health", 4]]);
    const band = (k: string) => html(storage, `releases/${k}/index.html`).split('<section class="media-container"')[1] ?? "";
    expect(band("K1")).toContain(">Two</a>");
    expect(band("K1")).not.toContain(">One</a>");
    expect(band("K2")).toContain(">One</a>");
    expect(band("K2")).not.toContain(">Two</a>");
    expect(band("K3")).toContain(">Nine</a>");

    // A failure: logged without the error's text, and the page renders with no Related Articles.
    const failing = setup(new Map([["K1", post({ key: "K1" })]]));
    failing.api.latest = async () => { throw new Error("News API 500 secret=abc"); };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await failing.builder.renderPage("post:K1", {});
    expect(failing.storage.files.has("releases/K1/index.html")).toBe(true);
    expect(html(failing.storage, "releases/K1/index.html")).not.toContain("Related Articles");
    expect(log.mock.calls.some(([line]) => String(line).includes("post:K1"))).toBe(true);
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret=abc");
    log.mockRestore();
  });

  it("buildAll renders every published key, removes pages for keys no longer published, then every aggregate", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })], ["S1", post({ key: "S1", kind: "stories" })]]));
    await storage.write("releases/OLD/index.html", "stale");
    const r = await builder.buildAll({});
    expect(r).toEqual({ posts: 3, failures: 0 });
    expect(storage.files.has("releases/OLD/index.html")).toBe(false);
    for (const f of ["releases/K1/index.html", "releases/S1/index.html", "index.html", "ministries/index.html", "ministries/health/index.html", "ministries/finance/index.html", "archive/index.html", "search/index.html", "sitemap.xml", "sitemaps/pages.xml", "assets/theme.css", "assets/site-banner.json", "connect/index.html", "privacy/index.html", "live/index.html", "assets/live.json", "robots.txt", "404.html"]) {
      expect(storage.files.has(f), f).toBe(true);
    }
    expect(html(storage, "sitemaps/pages.xml")).not.toContain("/search/");
    expect(html(storage, "sitemaps/pages.xml")).toContain("https://news.example/connect/");
    expect(html(storage, "sitemaps/pages.xml")).toContain("https://news.example/privacy/");
    expect(html(storage, "sitemaps/pages.xml")).toContain("https://news.example/live/");
  });

  it("live: renders live/index.html and assets/live.json from the home settings; an https playlist plays, none or http is off air; the flag file never holds the URL", async () => {
    const { storage, api, builder } = setup(new Map());
    await builder.rebuild(["live"], { settings: bcSettings() });
    expect(html(storage, "assets/live.json")).toBe('{"live":false}');
    expect(html(storage, "live/index.html")).toContain("There is no live webcast right now.");
    expect(html(storage, "live/index.html")).not.toContain("<video");
    api.home = async () => ({ granville: null, topPostKey: null, featurePostKey: null, liveWebcastM3uPlaylist: "https://stream.example/secret/live.m3u8" });
    await builder.rebuild(["live"], { settings: bcSettings() });
    expect(html(storage, "assets/live.json")).toBe('{"live":true}');
    expect(html(storage, "live/index.html")).toContain('data-stream="https://stream.example/secret/live.m3u8"');
    expect(html(storage, "live/index.html")).toContain("<strong>stream.example</strong>");
    api.home = async () => ({ granville: null, topPostKey: null, featurePostKey: null, liveWebcastM3uPlaylist: "http://stream.example/live.m3u8" });
    await builder.rebuild(["live"], { settings: bcSettings() });
    expect(html(storage, "assets/live.json")).toBe('{"live":false}');
    expect(html(storage, "live/index.html")).not.toContain("data-stream");
  });

  it("legacy-redirects writes legacy/ministry-successors.json from the News API, and is an aggregate page", async () => {
    const { storage, api, builder } = setup(new Map());
    api.successors = { b: "c", a: "c" };
    expect(await builder.renderPage("legacy-redirects", {})).toEqual([]);
    expect(JSON.parse(html(storage, "legacy/ministry-successors.json"))).toEqual({ successors: { a: "c", b: "c" } });
    // A reactivation (N12) empties the map: the file is rewritten, not left stale.
    api.successors = {};
    await builder.renderPage("legacy-redirects", {});
    expect(JSON.parse(html(storage, "legacy/ministry-successors.json"))).toEqual({ successors: {} });
    expect(await builder.aggregatePageIds()).toContain("legacy-redirects");
  });

  it("ministryPageIds: every ministry page, nothing else", async () => {
    const { builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    expect(await builder.ministryPageIds()).toEqual(["category:ministries:finance", "category:ministries:health"]);
  });

  // New-government spec §5: a published cabinet change emits one org event per ministry it touches,
  // and each queues the ministries index plus that ministry's page. One drain rebuilds /ministries/ once.
  it("25 org changes in one drain render ministries once", async () => {
    const { storage, builder } = setup(new Map());
    const render = vi.spyOn(builder, "renderPage");
    const ids = Array.from({ length: 25 }, (_, i) => [`category:ministries:ministry-${i}`, "ministries"]).flat();
    await builder.rebuild(ids, {});
    expect(render.mock.calls.filter(([id]) => id === "ministries")).toHaveLength(1);
    expect(render.mock.calls.filter(([id]) => id.startsWith("category:ministries:"))).toHaveLength(25);
    expect(storage.files.has("ministries/index.html")).toBe(true);
  });

  it("the connect page renders the settings it's given", async () => {
    const { storage, builder } = setup(new Map());
    const settings = bcSettings();
    settings.connect.blogs.featured = [{ text: "The Newest Blog", url: "https://news.example/blog" }];
    await builder.renderPage("connect", { settings });
    expect(html(storage, "connect/index.html")).toContain("The Newest Blog");
  });

  it("connect: RSS Feeds is the site feed, then active ministries, sectors and tags (no themes) by name, with the base path; Resources from the News API", async () => {
    const { storage, api, builder } = setup(new Map());
    const cat = (kind: string, key: string, name: string, isActive = true) => ({ key, kind, name, isActive, topPostKey: null, featurePostKey: null });
    api.sectors = [cat("sectors", "economy", "Economy"), cat("sectors", "old", "Retired", false)];
    const base = api.categories;
    api.categories = async (kind) => (kind === "tags" ? [cat("tags", "covid-19", "COVID-19")] : kind === "themes" ? [cat("themes", "housing", "Housing")] : base(kind));
    api.resourceLinks = async () => [{ uri: "/contacts/", key: "Media Contacts" }];
    await builder.renderPage("connect", {});
    const doc = new JSDOM(html(storage, "connect/index.html")).window.document;
    expect([...doc.querySelectorAll("details#rss li a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["BC Gov News", "/feed.xml"],
      ["COVID-19", "/tags/covid-19/feed.xml"],
      ["Economy", "/sectors/economy/feed.xml"],
      ["Finance", "/ministries/finance/feed.xml"],
      ["Health", "/ministries/health/feed.xml"],
    ]);
    expect(doc.querySelector(".home-features a")?.getAttribute("href")).toBe("/contacts/");
  });

  it("every generated HTML page passes the structure check", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    await builder.buildAll({ test: true });
    const { expectAccessibleStructure } = await import("../test/structure");
    for (const [path, content] of storage.files) {
      if (path.endsWith(".html")) {
        expectAccessibleStructure(String(content));
        expect(String(content), path).toContain('<meta name="robots" content="noindex, nofollow">');
      }
    }
  });

  describe("archive by government term", () => {
    const LEGACY = "https://archive.news.gov.bc.ca/releases";
    const t = (slug: string, startDate: string, endDate: string | null, legacyArchiveUrl: string | null = null): GovernmentTermDto => ({ slug, label: null, startDate, endDate, legacyArchiveUrl });
    const snapshot = (...terms: GovernmentTermDto[]): GovernmentTermsDto => ({ publishedAt: "2028-11-20T07:00:00.000Z", currentSlug: terms[0]!.slug, terms });
    const hrefs = (s: ReturnType<typeof memoryStorage>, path: string) => [...html(s, path).matchAll(/<main[\s\S]*<\/main>/g)].flatMap((m) => [...m[0].matchAll(/href="([^"]+)"/g)].map((x) => x[1]!));

    it("places boundary posts by BC day", async () => {
      const posts = new Map([
        ["EVE", post({ key: "EVE", publishDate: "2028-11-19T23:59:00-08:00" })],
        ["DAY", post({ key: "DAY", publishDate: "2028-11-20T00:00:00-08:00" })],
      ]);
      const { storage, api, builder } = setup(posts);
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"));
      await builder.rebuild(["post:EVE", "post:DAY"], {});
      const old = html(storage, "archive/terms/2024-2028/index.html");
      const now = html(storage, "archive/terms/2028-11-20/index.html");
      expect(old).toContain("/releases/EVE/");
      expect(old).not.toContain("/releases/DAY/");
      expect(now).toContain("/releases/DAY/");
      expect(now).not.toContain("/releases/EVE/");
      expect(html(storage, "archive/terms/current/index.html")).toContain("/releases/DAY/");
      expect(html(storage, "archive/terms/index.html")).toContain("(1 post)");
    });

    it("a short term lists only its weeks", async () => {
      const posts = new Map([
        ["IN", post({ key: "IN", publishDate: "2017-07-17T16:00:00-07:00" })],
        ["OUT", post({ key: "OUT", publishDate: "2017-07-18T09:00:00-07:00" })],
        ["BEFORE", post({ key: "BEFORE", publishDate: "2017-06-11T09:00:00-07:00" })],
      ]);
      const { storage, api, builder } = setup(posts);
      api.terms = snapshot(t("2017-2021", "2017-07-18", null), t("2017-2017", "2017-06-12", "2017-07-17"), t("2013-2017", "2013-06-10", "2017-06-11"));
      await builder.rebuild(["post:IN", "post:OUT", "post:BEFORE"], {});
      const page = html(storage, "archive/terms/2017-2017/index.html");
      expect(page).toContain("June 12, 2017 to July 17, 2017");
      expect(page).toContain("/releases/IN/");
      expect(page).not.toContain("/releases/OUT/");
      expect(page).not.toContain("/releases/BEFORE/");
    });

    it("empty current term renders the empty copy and the current alias canonicalises to the slug", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1", publishDate: "2026-10-03T10:00:00-07:00" })]]));
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"));
      await builder.buildAll({});
      for (const f of ["archive/terms/2028-11-20/index.html", "archive/terms/current/index.html"]) {
        expect(html(storage, f), f).toContain("Nothing has been published in this term yet.");
        expect(html(storage, f)).toContain("<h1>News from November 20, 2028 to current date</h1>");
        expect(/<link rel="canonical" href="([^"]+)"/.exec(html(storage, f))![1]).toMatch(/\/archive\/terms\/2028-11-20\/$/);
      }
      expect(html(storage, "archive/terms/2024-2028/index.html")).toContain("/releases/K1/");
    });

    it("adding a term links it from the index with no other change", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      api.terms = snapshot(t("2024-2028", "2024-11-18", null), t("2020-2024", "2020-11-26", "2024-11-17"));
      await builder.buildAll({});
      const before = hrefs(storage, "archive/terms/index.html");
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"), t("2020-2024", "2020-11-26", "2024-11-17"));
      await builder.rebuild(await builder.termPageIds(), {});
      const after = hrefs(storage, "archive/terms/index.html");
      expect(after.filter((h) => !before.includes(h))).toEqual(["/archive/terms/2028-11-20/"]);
      expect(before.filter((h) => !after.includes(h))).toEqual([]);
      expect(storage.files.has("archive/terms/2028-11-20/index.html")).toBe(true);
      // The crawler path: entry point → term page → every post in range.
      expect(html(storage, "archive/terms/2024-2028/index.html")).toContain("/releases/K1/");
    });

    it("legacy-only terms link out and get no page", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      api.terms = snapshot(t("2024-2028", "2024-11-18", null, `${LEGACY}/index_current.htm`), t("pre2001", "1994-01-01", "2001-06-04", `${LEGACY}/index_pre2001.htm`));
      await storage.write("archive/terms/pre2001/index.html", "stale");
      await builder.buildAll({});
      expect(hrefs(storage, "archive/terms/index.html")).toContain(`${LEGACY}/index_pre2001.htm`);
      expect(hrefs(storage, "archive/terms/index.html")).not.toContain("/archive/terms/pre2001/");
      expect(storage.files.has("archive/terms/pre2001/index.html")).toBe(false);
      expect(html(storage, "sitemaps/pages.xml")).not.toContain("/archive/terms/pre2001/");
    });

    it("sitemap pages list /archive/terms/ and each term page", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"));
      await builder.buildAll({});
      const xml = html(storage, "sitemaps/pages.xml");
      for (const path of ["/archive/terms/", "/archive/terms/2028-11-20/", "/archive/terms/2024-2028/"]) expect(xml).toContain(`<loc>https://news.example${path}</loc>`);
      expect(xml).not.toContain("/archive/terms/current/");
    });

    it("a post change queues its term page, the current alias and the index", async () => {
      const { api, builder } = setup(new Map([["K1", post({ key: "K1", publishDate: "2024-12-01T10:00:00-08:00" })]]));
      api.terms = snapshot(t("2024-11-18", "2024-11-18", null), t("2020-2024", "2020-11-26", "2024-11-17"));
      expect(await builder.renderPage("post:K1", {})).toEqual(expect.arrayContaining(["archive-term:2024-11-18", "archive-term:current", "archive-terms"]));
    });

    it("no terms published yet: the index says so and no term page is written", async () => {
      const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      await builder.buildAll({});
      expect(html(storage, "archive/terms/index.html")).toContain("No government terms have been published yet.");
      expect([...storage.files.keys()].filter((f) => f.startsWith("archive/terms/") && f !== "archive/terms/index.html")).toEqual([]);
      expect(await builder.termPageIds()).toEqual(["archive-terms", "archive-term:current"]);
    });

    it("a legacy term's first post (or its last leaving) queues the pages sitemap; a current-term post doesn't (F4)", async () => {
      const posts = new Map([["OLD", post({ key: "OLD", publishDate: "2021-03-01T10:00:00-08:00" })], ["NEW", post({ key: "NEW", publishDate: "2025-03-01T10:00:00-08:00" })]]);
      const { api, builder } = setup(posts);
      api.terms = snapshot(t("2024-2028", "2024-11-18", null, `${LEGACY}/index_current.htm`), t("2020-2024", "2020-11-26", "2024-11-17", `${LEGACY}/index_2020-2024.htm`));
      expect(await builder.renderPage("post:OLD", {})).toContain("sitemap:pages");
      expect(await builder.renderPage("post:NEW", {})).not.toContain("sitemap:pages");
      posts.delete("OLD");
      expect(await builder.renderPage("post:OLD", {})).toContain("sitemap:pages");
    });

    it("a term that has left the payload is rendered once more, which removes its page (F5)", async () => {
      const { storage, api, builder } = setup(new Map());
      api.terms = snapshot(t("2024-2028", "2024-11-18", null));
      await storage.write("archive/terms/2028-11-20/index.html", "stale");
      const ids = await builder.termPageIds();
      expect(ids).toContain("archive-term:2028-11-20");
      await builder.rebuild(ids, {});
      expect(storage.files.has("archive/terms/2028-11-20/index.html")).toBe(false);
      expect(storage.files.has("archive/terms/2024-2028/index.html")).toBe(true);
    });

    describe("a terms outage (NG-R18)", () => {
      const terms = snapshot(t("2024-2028", "2024-11-18", null), t("2020-2024", "2020-11-26", "2024-11-17"));
      const failing = (api: ReturnType<typeof setup>["api"], times = Infinity) => {
        let left = times;
        const real = api.governmentTerms;
        api.governmentTerms = async () => {
          if (left-- > 0) throw new Error("News API 503 for api/v2/government-terms");
          return real();
        };
      };
      beforeEach(async () => { await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });

      it("terms 5xx during a drain: every post page is still written; the alias and index are queued", async () => {
        const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2" })]]));
        failing(api);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await enqueuePages(tdb.db, [{ pageId: "post:K1", priority: 0 }, { pageId: "post:K2", priority: 0 }]);
          await drainQueue({ db: tdb.db, builder }, { budget: 50, pageOpts: {} });
          expect(storage.files.has("releases/K1/index.html")).toBe(true);
          expect(storage.files.has("releases/K2/index.html")).toBe(true);
          expect(html(storage, "archive/2026/10/index.html")).toContain("/releases/K2/");
          // Logged once for the outage, not once per caller.
          expect(error.mock.calls.filter(([m]) => String(m).includes("government terms unavailable"))).toHaveLength(1);
        } finally {
          error.mockRestore();
        }
        expect(await builder.renderPage("post:K1", {})).toEqual(expect.arrayContaining(["archive-terms", "archive-term:current"]));
      });

      it("20 posts in a drain with terms failing: one fetch attempt, all 20 pages written; the next drain retries", async () => {
        const posts = new Map(Array.from({ length: 20 }, (_, i) => [`K${i}`, post({ key: `K${i}` })] as const));
        const { storage, api, builder } = setup(posts);
        let fetches = 0;
        api.governmentTerms = async () => { fetches++; throw new Error("News API 503 for api/v2/government-terms"); };
        vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await enqueuePages(tdb.db, [...posts.keys()].map((k) => ({ pageId: `post:${k}`, priority: 0 })));
          await drainQueue({ db: tdb.db, builder }, { budget: 20, pageOpts: {} });
          expect(fetches).toBe(1);
          for (const k of posts.keys()) expect(storage.files.has(`releases/${k}/index.html`), k).toBe(true);
          await enqueuePages(tdb.db, [{ pageId: "post:K0", priority: 0 }]);
          await drainQueue({ db: tdb.db, builder }, { budget: 1, pageOpts: {} });
          expect(fetches).toBe(2);
        } finally {
          vi.mocked(console.error).mockRestore();
        }
      });

      it("after an outage that rendered without terms, the next snapshot queues every term page, durably", async () => {
        const { builder: warm, api } = setup(new Map([["K1", post({ key: "K1" })]]));
        api.terms = terms;
        expect(await warm.renderPage("post:K1", {})).toContain("archive-term:2020-2024"); // first sight of the snapshot
        expect(await warm.renderPage("post:K1", {})).not.toContain("archive-term:2020-2024"); // applied
        // An outage on a site with nothing persisted (a fresh folder): rendered without terms.
        const { builder: cold, api: coldApi } = setup(new Map([["K1", post({ key: "K1" })]]));
        coldApi.governmentTerms = async () => { throw new Error("News API 503"); };
        vi.spyOn(console, "error").mockImplementationOnce(() => {});
        expect(await cold.renderPage("post:K1", {})).toEqual(expect.arrayContaining(["archive-terms", "archive-term:current"]));
        coldApi.governmentTerms = async () => terms;
        const all = ["archive-terms", "archive-term:current", "archive-term:2024-2028", "archive-term:2020-2024", "sitemap:pages"];
        // The item that notices rolls back (its transaction fails after the render)...
        await expect(tdb.db.transaction(async (tx) => {
          expect(await cold.renderPage("post:K1", {}, {}, tx)).toEqual(expect.arrayContaining(all));
          throw new Error("drain item failed");
        })).rejects.toThrow("drain item failed");
        // ...so the next run notices again; once committed, it's quiet.
        expect(await cold.renderPage("post:K1", {})).toEqual(expect.arrayContaining(all));
        expect(await cold.renderPage("post:K1", {})).not.toContain("archive-term:2020-2024");
      });

      it("keeps the last applied terms: term pages render from them and aren't deleted", async () => {
        const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
        api.terms = terms;
        await builder.buildAll({});
        expect(storage.files.has(".government-terms.json")).toBe(true);
        failing(api);
        vi.spyOn(console, "error").mockImplementationOnce(() => {});
        await storage.write("archive/terms/2024-2028/index.html", "old");
        await builder.rebuild(["archive-term:2024-2028", "archive-term:current", "archive-terms"], {});
        expect(html(storage, "archive/terms/2024-2028/index.html")).toContain("/releases/K1/");
        expect(await builder.termPageIds()).toEqual(expect.arrayContaining(["archive-term:2024-2028", "archive-term:2020-2024"]));
      });

      it("with nothing applied yet, a term page render fails (retried) rather than replacing a page", async () => {
        const { storage, api, builder } = setup(new Map());
        failing(api);
        vi.spyOn(console, "error").mockImplementationOnce(() => {});
        await storage.write("archive/terms/index.html", "good");
        await expect(builder.renderPage("archive-terms", {})).rejects.toThrow(/unavailable/);
        expect(html(storage, "archive/terms/index.html")).toBe("good");
      });

      it("rebuild-all with a terms failure still enqueues every non-term page", async () => {
        const { api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
        failing(api);
        vi.spyOn(console, "error").mockImplementationOnce(() => {});
        const ids = (await rebuildAllItems(builder)).map((i) => i.pageId);
        expect(ids).toEqual(expect.arrayContaining(["post:K1", "home", "archive", "sitemap", "sitemap:pages", "category:ministries:health", "legacy-redirects", "archive-terms", "archive-term:current"]));
      });
    });

    it("termPageIds: the index, the alias and every public term", async () => {
      const { api, builder } = setup(new Map());
      api.terms = snapshot(t("2024-2028", "2024-11-18", null), t("pre2001", "1994-01-01", "2001-06-04", `${LEGACY}/x.htm`));
      expect(await builder.termPageIds()).toEqual(["archive-terms", "archive-term:current", "archive-term:2024-2028", "archive-term:pre2001"]);
    });
  });
});
