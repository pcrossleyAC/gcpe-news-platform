import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import { readCursor } from "./cursor";
import { postIndex, type PostIndex } from "./post-index";
import { nextBatch, PRIORITY } from "./queue";
import { syncSite } from "./sync";
import { CATEGORY_CHANGE, ChangeFeedError, changesClient, pagesForChange, syncChanges, type ChangeRow, type ChangesClient, type ChangesPage } from "./change-feed";

describe("pagesForChange", () => {
  it.each([
    [{ id: 1, kind: "post.upserted", key: "K1" }, [{ pageId: "post:K1", priority: 0 }]],
    [{ id: 2, kind: "post.unpublished", key: "K1" }, [{ pageId: "post:K1", priority: 0 }]],
    [{ id: 3, kind: "home", key: null }, [{ pageId: "home", priority: 1 }]],
    [{ id: 4, kind: "slides", key: null }, [{ pageId: "home", priority: 1 }]],
    [{ id: 5, kind: "resource_links", key: null }, [{ pageId: "home", priority: 1 }]],
    // A ministry change can start or stop a successor redirect, so it also queues legacy-redirects,
    // one priority lower, so a new successor's page is written before anything 301s to it.
    [{ id: 6, kind: "ministry", key: "Health" }, [{ pageId: "category:ministries:health", priority: 1 }, { pageId: "ministries", priority: 1 }, { pageId: "search", priority: 1 }, { pageId: "legacy-redirects", priority: 2 }, { pageId: "sitemap:pages", priority: 1 }]],
    [{ id: 7, kind: "tag", key: "covid-19" }, [{ pageId: "category:tags:covid-19", priority: 1 }, { pageId: "sitemap:pages", priority: 1 }]],
    [{ id: 8, kind: "post.upserted", key: "../x" }, []],
    [{ id: 9, kind: "ministry", key: null }, []],
    [{ id: 10, kind: "sector", key: "a b" }, []],
    // The next sync turn fetches the settings and decides what each changed section needs.
    [{ id: 11, kind: "site_settings", key: null }, []],
    // Every term page is added by syncChanges, from the builder's terms.
    [{ id: 12, kind: "government_terms", key: null }, [{ pageId: "archive-terms", priority: 1 }, { pageId: "archive-term:current", priority: 1 }, { pageId: "sitemap:pages", priority: 1 }]],
  ] as const)("%j", (change, expected) => {
    expect(pagesForChange(change as ChangeRow, 0)).toEqual(expected);
  });

  it("a post change takes the priority it's given", () => {
    expect(pagesForChange({ id: 1, kind: "post.upserted", key: "K1" }, 2)).toEqual([{ pageId: "post:K1", priority: 2 }]);
  });

  // A kind this build doesn't recognise (a forward-compatible News API addition)
  // is ignored, not guessed at — no `category:undefined:<key>` page from blindly indexing
  // CATEGORY_CHANGE with an unknown kind.
  it("an unrecognised kind is ignored, not guessed at", () => {
    expect(pagesForChange({ id: 99, kind: "widget_updated" as unknown as ChangeRow["kind"], key: "something" }, 0)).toEqual([]);
  });
});

describe("CATEGORY_CHANGE", () => {
  it("maps every category change kind to its CategoryKind", () => {
    expect(CATEGORY_CHANGE).toEqual({ ministry: "ministries", sector: "sectors", theme: "themes", tag: "tags" });
  });

  // `Object.hasOwn`, not a bare `in`, which also matches inherited names from Object.prototype.
  it("does not match an Object.prototype property name", () => {
    expect(Object.hasOwn(CATEGORY_CHANGE, "constructor")).toBe(false);
    expect("constructor" in CATEGORY_CHANGE).toBe(true); // the very thing a bare `in` gets wrong
  });
});

function fakeResponse(opts: { status: number; body: unknown }): Response {
  return { ok: opts.status >= 200 && opts.status < 300, status: opts.status, json: async () => opts.body } as unknown as Response;
}

describe("changesClient", () => {
  const getToken = async () => "secret-token-value";

  it("sends Authorization: Bearer <token> to <base>/api/v2/changes?after=&limit=", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => fakeResponse({ status: 200, body: { changes: [], next: 7 } }));
    const client = changesClient({ baseUrl: "http://host", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.read(7, 500);
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe("http://host/api/v2/changes?after=7&limit=500");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token-value");
  });

  it("keeps a path prefix with a trailing slash", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => fakeResponse({ status: 200, body: { changes: [], next: 7 } }));
    const client = changesClient({ baseUrl: "http://host/news/", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.read(7, 500);
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe("http://host/news/api/v2/changes?after=7&limit=500");
  });

  it("keeps a path prefix with no trailing slash", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => fakeResponse({ status: 200, body: { changes: [], next: 7 } }));
    const client = changesClient({ baseUrl: "http://host/news", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.read(7, 500);
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toBe("http://host/news/api/v2/changes?after=7&limit=500");
  });

  it("200 maps to { resync: false, changes, next }", async () => {
    const changes = [{ id: 8, kind: "home", key: null }];
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 200, body: { changes, next: 8 } }));
    const client = changesClient({ baseUrl: "http://host", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.read(7, 500)).toEqual({ resync: false, changes, next: 8 });
  });

  it("410 with { resync: true, next } maps to { resync: true, next }", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 410, body: { resync: true, next: 99 } }));
    const client = changesClient({ baseUrl: "http://host", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.read(0, 500)).toEqual({ resync: true, next: 99 });
  });

  it.each([401, 403, 503, 500])("%d rejects with 'News API changes <status>', never the token", async (status) => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status, body: { error: "nope" } }));
    const client = changesClient({ baseUrl: "http://host", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.read(0, 500)).rejects.toThrow(`News API changes ${status}`);
    try {
      await client.read(0, 500);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("secret-token-value");
    }
  });

  // safeErrorLabel (the one place a feed failure is logged, sync.ts) reads
  // `.name` for a plain Error — which is always the bare word "Error", making a 401 and a 503
  // indistinguishable in the log. ChangeFeedError's `.name` carries the status instead.
  it("a 401 and a 503 are distinguishable via safeErrorLabel, and neither carries the token or the URL", async () => {
    const errorFor = async (status: number): Promise<Error> => {
      const fetchImpl = vi.fn(async () => fakeResponse({ status, body: { error: "nope" } }));
      const client = changesClient({ baseUrl: "http://host/news-api", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
      try {
        await client.read(0, 500);
        throw new Error("expected read() to reject");
      } catch (err) {
        return err as Error;
      }
    };
    const err401 = await errorFor(401);
    const err503 = await errorFor(503);
    expect(err401).toBeInstanceOf(ChangeFeedError);
    expect(safeErrorLabel(err401)).not.toBe(safeErrorLabel(err503));
    for (const err of [err401, err503]) {
      expect(safeErrorLabel(err)).not.toContain("secret-token-value");
      expect(safeErrorLabel(err)).not.toContain("http://host");
      expect(err.message).not.toContain("secret-token-value");
      expect(err.message).not.toContain("http://host");
    }
  });

  it("a malformed 200 body (changes not an array) rejects", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 200, body: { changes: "not-an-array", next: 7 } }));
    const client = changesClient({ baseUrl: "http://host", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.read(0, 500)).rejects.toThrow();
  });

  it("a malformed 200 body (a change row missing id) rejects", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 200, body: { changes: [{ kind: "home", key: null }], next: 7 } }));
    const client = changesClient({ baseUrl: "http://host", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.read(0, 500)).rejects.toThrow();
  });

  it("a malformed 410 body (missing next) rejects", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 410, body: { resync: true } }));
    const client = changesClient({ baseUrl: "http://host", getToken, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.read(0, 500)).rejects.toThrow();
  });
});

/** A scripted ChangesClient: serves the given pages in order, recording the `after` it was
 * called with each time. */
function scriptedClient(pages: ChangesPage[]): ChangesClient & { calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  return {
    calls,
    async read(after) {
      calls.push(after);
      const page = pages[Math.min(i, pages.length - 1)]!;
      i++;
      return page;
    },
  };
}

describe("syncChanges", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); await tdb.pool.query("TRUNCATE site_state"); });

  const setup = () => {
    const storage = memoryStorage();
    const newsApi = fakeNewsApi();
    const index = postIndex(tdb.db);
    const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
    return { db: tdb.db, builder, index, newsApi, storage };
  };

  const items = async () => (await nextBatch(tdb.db, 10_000, [])).map((i) => `${i.pageId}@${i.priority}`);

  it("first run: reads to the head without enqueueing changes, then queues a full rebuild and saves the head", async () => {
    const { db, builder, index } = setup();
    const client = scriptedClient([
      { resync: false, changes: [{ id: 1, kind: "home", key: null }, { id: 2, kind: "slides", key: null }], next: 2 },
      { resync: false, changes: [{ id: 3, kind: "home", key: null }], next: 3 },
      { resync: false, changes: [], next: 3 },
    ]);
    const result = await syncChanges({ db, client, builder, index });
    expect(await readCursor(db)).toBe(3);
    expect(result).toEqual({ changes: 0, resynced: true });
    // Only rebuild-all's own items — nothing extra from the three change pages read to the head.
    const rebuildAllItems = await items();
    expect(rebuildAllItems).toContain("home@1");
    expect(rebuildAllItems.filter((x) => x === "home@1")).toHaveLength(1);
  });

  it("applies changes after the cursor, enqueues their pages and saves the cursor", async () => {
    const { db, builder, index } = setup();
    const { rows } = await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    void rows;
    const client = scriptedClient([
      { resync: false, changes: [{ id: 4, kind: "post.upserted", key: "K9" }, { id: 5, kind: "home", key: null }], next: 5 },
      { resync: false, changes: [], next: 5 },
    ]);
    const result = await syncChanges({ db, client, builder, index });
    expect(await items()).toEqual(["post:K9@0", "home@1"]);
    expect(await readCursor(db)).toBe(5);
    expect(result).toEqual({ changes: 2, resynced: false });
  });

  it("a ministry change also queues its posts' release pages as bulk", async () => {
    const { db, builder, index } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    await index.put({ key: "K1", kind: "releases", headline: "H1", summary: null, publishDate: "2026-10-01T09:00:00-07:00", month: "2026-10", categories: ["ministries:health"] });
    await index.put({ key: "K2", kind: "releases", headline: "H2", summary: null, publishDate: "2026-10-02T09:00:00-07:00", month: "2026-10", categories: ["ministries:health"] });
    const client = scriptedClient([
      { resync: false, changes: [{ id: 4, kind: "ministry", key: "Health" }], next: 4 },
      { resync: false, changes: [], next: 4 },
    ]);
    await syncChanges({ db, client, builder, index });
    const queued = await items();
    expect(queued).toContain("post:K1@2");
    expect(queued).toContain("post:K2@2");
  });

  it("a government_terms change queues every term page", async () => {
    const { db, builder, index, newsApi } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    const term = (slug: string, startDate: string, endDate: string | null) => ({ slug, label: null, startDate, endDate, legacyArchiveUrl: null });
    newsApi.terms = { publishedAt: "2028-11-20T07:00:00.000Z", currentSlug: "2028-11-20", terms: [term("2028-11-20", "2028-11-20", null), term("2024-2028", "2024-11-18", "2028-11-19"), term("2017-2017", "2017-06-12", "2017-07-17")] };
    const client = scriptedClient([
      { resync: false, changes: [{ id: 4, kind: "government_terms", key: null }], next: 4 },
      { resync: false, changes: [], next: 4 },
    ]);
    await syncChanges({ db, client, builder, index });
    const queued = (await items()).map((x) => x.split("@")[0]);
    expect(queued).toEqual(expect.arrayContaining(["archive-terms", "archive-term:current", "archive-term:2028-11-20", "archive-term:2024-2028", "archive-term:2017-2017", "sitemap:pages"]));
  });

  it("a change page with a terms failure still queues its post changes and advances the cursor (NG-R18)", async () => {
    const { db, builder, index, newsApi } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    newsApi.governmentTerms = async () => { throw new Error("News API 503 for api/v2/government-terms"); };
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    const client = scriptedClient([
      { resync: false, changes: [{ id: 4, kind: "post.upserted", key: "K9" }, { id: 5, kind: "government_terms", key: null }], next: 5 },
      { resync: false, changes: [], next: 5 },
    ]);
    await syncChanges({ db, client, builder, index });
    expect((await items()).map((x) => x.split("@")[0])).toEqual(expect.arrayContaining(["post:K9", "archive-terms", "archive-term:current", "sitemap:pages"]));
    expect(await readCursor(db)).toBe(5);
  });

  it("a publish during a backlog renders first", async () => {
    const { db, builder, index, newsApi, storage } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    const changes: ChangeRow[] = Array.from({ length: 150 }, (_, i) => ({ id: 4 + i, kind: "post.upserted", key: `K${i}` }));
    const client = scriptedClient([
      { resync: false, changes, next: 153 },
      { resync: false, changes: [], next: 153 },
    ]);
    await syncChanges({ db, client, builder, index }, { livePostLimit: 100 });
    const batch = await nextBatch(tdb.db, 10_000, []);
    const at = (p: number) => batch.filter((i) => i.priority === p).map((i) => i.pageId);
    expect(at(0)).toHaveLength(100);
    expect(at(2)).toHaveLength(50);

    (newsApi as ReturnType<typeof fakeNewsApi>).posts.set("LIVE", { key: "LIVE", kind: "releases", publishDate: "2026-10-05T09:00:00-07:00", summary: "s", location: "VICTORIA", ministryKeys: [], tagKeys: [], documents: [{ languageId: 4105, headline: "Live", subheadline: null, detailsHtml: "<p>x</p>", contacts: [] }], azureAssets: [], azureTranslations: [] });
    await syncSite({ db, builder, index, newsApi, storage, site, test: false, batch: 101 }, { pages: ["post:LIVE"] });
    expect((storage as ReturnType<typeof memoryStorage>).files.has("releases/LIVE/index.html")).toBe(true);
  });

  it("a 410 queues a full rebuild and moves the cursor to next in one transaction", async () => {
    const { db, builder, index } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    const client = scriptedClient([
      { resync: true, next: 500 },
      { resync: false, changes: [], next: 500 },
    ]);
    const result = await syncChanges({ db, client, builder, index });
    expect(await readCursor(db)).toBe(500);
    expect(result.resynced).toBe(true);
  });

  // A well-formed page containing one row with a kind this build doesn't
  // recognise must not stall or corrupt the sync — it contributes no page (pagesForChange's
  // own unit test above covers that in isolation), and the page's own `next` still advances
  // the cursor, same as any other page.
  it("an unrecognised kind in an otherwise well-formed page is ignored; the cursor still advances past it", async () => {
    const { db, builder, index } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    const client = scriptedClient([
      { resync: false, changes: [{ id: 4, kind: "widget_updated" as unknown as ChangeRow["kind"], key: "something" }, { id: 5, kind: "home", key: null }], next: 5 },
      { resync: false, changes: [], next: 5 },
    ]);
    await syncChanges({ db, client, builder, index });
    expect(await readCursor(db)).toBe(5);
    const queued = await items();
    expect(queued).toEqual(["home@1"]);
  });

  // `kind` is validated only as a non-empty string (changeRowSchema), so a value such as
  // "constructor" must not reach the prototype chain's own `Object.prototype.constructor` via a
  // bare `in` check — it's an unrecognised kind like any other, contributing no page.
  it("a kind matching an Object.prototype property name is ignored, not matched via the prototype chain", async () => {
    const { db, builder, index } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    const client = scriptedClient([
      { resync: false, changes: [{ id: 4, kind: "constructor" as unknown as ChangeRow["kind"], key: "something" }, { id: 5, kind: "home", key: null }], next: 5 },
      { resync: false, changes: [], next: 5 },
    ]);
    await syncChanges({ db, client, builder, index });
    expect(await readCursor(db)).toBe(5);
    const queued = await items();
    expect(queued).toEqual(["home@1"]);
    expect(queued.some((pageId) => pageId.includes("undefined"))).toBe(false);
  });

  // A malformed response (here, the client itself rejecting the way a real
  // schema-validation failure would) is a feed failure like any other — the read throws before
  // syncChanges ever opens the enqueue+cursor transaction for that page.
  it("a malformed response leaves the cursor unchanged", async () => {
    const { db, builder, index } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    const client: ChangesClient = {
      read: async () => {
        throw new Error("malformed response");
      },
    };
    await expect(syncChanges({ db, client, builder, index })).rejects.toThrow("malformed response");
    expect(await readCursor(db)).toBe(3);
    expect(await items()).toEqual([]);
  });

  it("enqueue and cursor commit together: a failing enqueue leaves the cursor where it was", async () => {
    const { db, builder, index } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    index.inCategory = async () => {
      throw new Error("index unavailable");
    };
    const client = scriptedClient([{ resync: false, changes: [{ id: 4, kind: "ministry", key: "Health" }], next: 4 }]);
    await expect(syncChanges({ db, client, builder, index })).rejects.toThrow("index unavailable");
    expect(await readCursor(db)).toBe(3);
    expect(await items()).toEqual([]);
  });

  it("stops after maxPages pages", async () => {
    const { db, builder, index } = setup();
    await tdb.pool.query("INSERT INTO site_state (id, change_cursor) VALUES (1, 3)");
    const client = scriptedClient([
      { resync: false, changes: [{ id: 4, kind: "home", key: null }], next: 4 },
      { resync: false, changes: [{ id: 5, kind: "home", key: null }], next: 5 },
      { resync: false, changes: [{ id: 6, kind: "home", key: null }], next: 6 },
    ]);
    await syncChanges({ db, client, builder, index }, { maxPages: 2 });
    expect(client.calls).toHaveLength(2);
  });
});
