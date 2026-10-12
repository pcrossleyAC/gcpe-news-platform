import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import type { PostDto } from "./dto";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { RENDER_CHROME_VERSION } from "./rebuild";
import { selfHeal } from "./self-heal";

const SUBSCRIBE_FILES = ["subscribe/index.html", "subscribe/manage/index.html", "subscribe/unsubscribe/index.html"];

describe("selfHeal", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); });

  const setup = (posts = new Map<string, PostDto>()) => {
    const storage = memoryStorage();
    const newsApi = fakeNewsApi(posts);
    const builder = createSiteBuilder({ newsApi, storage, index: postIndex(tdb.db), site, assetsDir: null });
    return { storage, newsApi, builder };
  };

  it("an empty output folder gets a full build, and the subscribe pages are written", async () => {
    const posts = new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2", publishDate: "2026-09-01T10:00:00-07:00" })]]);
    const { storage, newsApi, builder } = setup(posts);

    const result = await selfHeal({ builder, newsApi, storage, site, test: false });
    expect(result).toEqual({ rebuilt: 2 });
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(storage.files.has("releases/K2/index.html")).toBe(true);
    for (const f of SUBSCRIBE_FILES) expect(storage.files.has(f)).toBe(true);
  });

  it("an existing site with the current marker writes only the subscribe pages and the static pages", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const { storage, newsApi, builder } = setup(posts);
    await selfHeal({ builder, newsApi, storage, site, test: false }); // bootstrap, writes the marker

    const before = storage.files.get("releases/K1/index.html");
    const getPostCallsBefore = newsApi.calls.filter((c) => c === "getPost:K1").length;

    const result = await selfHeal({ builder, newsApi, storage, site, test: false });
    expect(result).toBeNull();
    expect(storage.files.get("releases/K1/index.html")).toBe(before); // untouched
    expect(newsApi.calls.filter((c) => c === "getPost:K1").length).toBe(getPostCallsBefore); // no further post render
    for (const f of SUBSCRIBE_FILES) expect(storage.files.has(f)).toBe(true);
    expect(storage.files.has("assets/theme.css")).toBe(true);
    expect(storage.files.has("robots.txt")).toBe(true);
    expect(storage.files.has("404.html")).toBe(true);
  });

  it("a News API outage logs, never throws, returns null, and still writes the subscribe pages", async () => {
    const { storage, newsApi, builder } = setup();
    newsApi.home = async () => {
      throw new Error("News API down");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await selfHeal({ builder, newsApi, storage, site, test: false });
      expect(result).toBeNull();
      expect(errSpy).toHaveBeenCalled();
      for (const f of SUBSCRIBE_FILES) expect(storage.files.has(f)).toBe(true);
      expect(storage.files.has("index.html")).toBe(false); // nothing else could be rendered correctly
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a marker from the old chrome (2) triggers a full build", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const { storage, newsApi, builder } = setup(posts);
    await storage.write("index.html", "<p>stale, pre chrome 3</p>");
    await storage.write(".site-state.json", JSON.stringify({ granvilleOn: false, test: false, chrome: 2, baseUrl: site.baseUrl }));

    const result = await selfHeal({ builder, newsApi, storage, site, test: false });
    expect(result).toEqual({ rebuilt: 1 });
    expect(storage.files.get("index.html")).not.toBe("<p>stale, pre chrome 3</p>");
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(JSON.parse(storage.files.get(".site-state.json") as string)).toEqual({ granvilleOn: false, test: false, chrome: RENDER_CHROME_VERSION, baseUrl: site.baseUrl });
  });
});
