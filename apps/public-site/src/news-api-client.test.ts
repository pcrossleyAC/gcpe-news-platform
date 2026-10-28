import { describe, expect, it, vi } from "vitest";
import { newsApiClient } from "./news-api-client";
import { bcSettings } from "../test/fixtures";

function fakeResponse(opts: { ok: boolean; status?: number; body: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    text: async () => opts.body,
  } as unknown as Response;
}

function stubFetch(response: Response) {
  return vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(response));
}

describe("newsApiClient", () => {
  it("treats an empty 200 body as null (not found)", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    expect(await client.getPost("K1")).toBeNull();
  });

  it("treats a whitespace-only 200 body as null", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "   \n  " }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    expect(await client.getPost("K1")).toBeNull();
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: false, status: 500, body: "boom" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    await expect(client.getPost("K1")).rejects.toThrow(/500/);
  });

  it("throws on a non-JSON 200 body", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "not json" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    await expect(client.getPost("K1")).rejects.toThrow();
  });

  it("builds URLs against a root base", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "null" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    await client.getPost("K1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://host/api/Posts/K1?api-version=1.0");
    await client.latestHome(10);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("http://host/api/Posts/Latest/home/default?api-version=1.0&count=10");
  });

  // Fix round 1, item 6: new URL("/api/...", "http://host/news/") discards the "/news" prefix
  // because a leading slash makes the second argument absolute relative to the origin.
  it("keeps a path prefix when NEWS_API_URL has one, with a trailing slash", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "null" }));
    const client = newsApiClient("http://host/news/", fetchImpl as unknown as typeof fetch);
    await client.getPost("K1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://host/news/api/Posts/K1?api-version=1.0");
  });

  it("keeps a path prefix when NEWS_API_URL has no trailing slash", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "null" }));
    const client = newsApiClient("http://host/news", fetchImpl as unknown as typeof fetch);
    await client.getPost("K1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://host/news/api/Posts/K1?api-version=1.0");
  });

  // Plan 3d task 4: home() reads Project Blue Bridge's granville text off News API's /api/Home,
  // which already projects it (tasks 1–3).
  it("home() fetches GET api/Home and returns granville", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: JSON.stringify({ granville: "true", topPostKey: null, featurePostKey: null }) }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    expect(await client.home()).toMatchObject({ granville: "true" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://host/api/Home?api-version=1.0");
  });

  it("home() rejects on a non-2xx response", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: false, status: 503, body: "down" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    await expect(client.home()).rejects.toThrow(/503/);
  });

  it("latest: an unknown category (404 problem JSON) is an empty list, not an error", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ status: 404 }), { status: 404 }));
    const c = newsApiClient("http://api.example/", fetchImpl as unknown as typeof fetch);
    expect(await c.latest("ministries", "gone", 20)).toEqual([]);
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Posts/Latest/ministries/gone?api-version=1.0&count=20");
  });

  it("latest: a known category is fetched by kind and key, count included", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json([{ key: "K1" }]));
    const c = newsApiClient("http://api.example", fetchImpl as unknown as typeof fetch);
    expect(await c.latest("sectors", "economy", 5)).toEqual([{ key: "K1" }]);
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Posts/Latest/sectors/economy?api-version=1.0&count=5");
  });

  it("latestHome: fetches the home latest list and encodes the count", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json([{ key: "K1" }]));
    const c = newsApiClient("http://api.example", fetchImpl as unknown as typeof fetch);
    expect(await c.latestHome(20)).toEqual([{ key: "K1" }]);
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Posts/Latest/home/default?api-version=1.0&count=20");
  });

  it("postsByKeys: fetches by a comma-joined, encoded key list; an empty list skips the call", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json([{ key: "K1" }, { key: "K2" }]));
    const c = newsApiClient("http://api.example", fetchImpl as unknown as typeof fetch);
    expect(await c.postsByKeys(["K1", "K2"])).toEqual([{ key: "K1" }, { key: "K2" }]);
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Posts?api-version=1.0&postKeys=K1%2CK2");
    expect(await c.postsByKeys([])).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ministries/categories/slides/resourceLinks: fetch their list endpoints, defaulting a null 200 body to []", async () => {
    const empty = vi.fn(async (_url: string | URL | Request) => new Response("", { status: 200 }));
    const c = newsApiClient("http://api.example", empty as unknown as typeof fetch);
    expect(await c.ministries()).toEqual([]);
    expect(empty.mock.calls[0]![0].toString()).toBe("http://api.example/api/Ministries?api-version=1.0");
    expect(await c.categories("sectors")).toEqual([]);
    expect(empty.mock.calls[1]![0].toString()).toBe("http://api.example/api/Sectors?api-version=1.0");
    expect(await c.categories("themes")).toEqual([]);
    expect(empty.mock.calls[2]![0].toString()).toBe("http://api.example/api/Themes?api-version=1.0");
    expect(await c.categories("tags")).toEqual([]);
    expect(empty.mock.calls[3]![0].toString()).toBe("http://api.example/api/Tags?api-version=1.0");
    expect(await c.slides()).toEqual([]);
    expect(empty.mock.calls[4]![0].toString()).toBe("http://api.example/api/v2/slides");
    expect(await c.resourceLinks()).toEqual([]);
    expect(empty.mock.calls[5]![0].toString()).toBe("http://api.example/api/ResourceLinks?api-version=1.0");
  });

  it("slides: reads the v2 shape (emergency, imageUrl) from GET api/v2/slides", async () => {
    const body = { slides: [{ id: "a", sortIndex: -1, emergency: true, headline: "h", summary: "s", actionUri: null, actionLabel: null, imageUrl: "https://files.example/x.png", justify: null }] };
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json(body));
    const c = newsApiClient("http://api.example", fetchImpl as unknown as typeof fetch);
    expect(await c.slides()).toEqual(body.slides);
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/v2/slides");
  });

  it("category: fetches one category of a kind by key", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json({ key: "economy" }));
    const c = newsApiClient("http://api.example", fetchImpl as unknown as typeof fetch);
    expect(await c.category("sectors", "economy")).toEqual({ key: "economy" });
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Sectors/economy?api-version=1.0");
  });

  it("related: maps v2 results; a 404 (unpublished meanwhile) is an empty list", async () => {
    const ok = vi.fn(async (_url: string | URL | Request) => Response.json({ mode: "text", results: [{ key: "K2", kind: "releases", headline: "H", summary: null, publishDate: "2026-10-01T09:00:00-07:00", leadMinistryKey: null, url: "x" }] }));
    expect(await newsApiClient("http://api.example", ok as unknown as typeof fetch).related("K1")).toEqual([{ key: "K2", headline: "H", publishDate: "2026-10-01T09:00:00-07:00" }]);
    expect(ok.mock.calls[0]![0].toString()).toBe("http://api.example/api/v2/posts/K1/related");
    const gone = vi.fn(async (_url: string | URL | Request) => new Response("{}", { status: 404 }));
    expect(await newsApiClient("http://api.example", gone as unknown as typeof fetch).related("K1")).toEqual([]);
  });

  it("postKeys: every published key of one kind", async () => {
    const f = vi.fn(async (_url: string | URL | Request) => Response.json([{ key: "A", value: "stories" }, { key: "B", value: "stories" }]));
    expect(await newsApiClient("http://api.example", f as unknown as typeof fetch).postKeys("stories")).toEqual(["A", "B"]);
    expect(f.mock.calls[0]![0].toString()).toBe("http://api.example/api/Posts/Keys/home/default?api-version=1.0&postKind=stories");
  });

  it("ministry/category/minister: v1's empty 200 is null", async () => {
    const empty = vi.fn(async (_url: string | URL | Request) => new Response("", { status: 200 }));
    const c = newsApiClient("http://api.example", empty as unknown as typeof fetch);
    expect(await c.ministry("x")).toBeNull();
    expect(await c.minister("x")).toBeNull();
    expect(await c.category("tags", "x")).toBeNull();
  });

  it("ministry: fetches one ministry by key", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json({ key: "health" }));
    const c = newsApiClient("http://api.example", fetchImpl as unknown as typeof fetch);
    expect(await c.ministry("health")).toEqual({ key: "health" });
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Ministries/health?api-version=1.0");
  });

  it("minister: fetches a ministry's minister", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json({ headline: "H" }));
    const c = newsApiClient("http://api.example", fetchImpl as unknown as typeof fetch);
    expect(await c.minister("health")).toEqual({ headline: "H" });
    expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Ministries/health/Minister?api-version=1.0");
  });

  describe("siteSettings", () => {
    it("GETs api/v2/site-settings and returns the revision and document", async () => {
      const document = bcSettings();
      const fetchImpl = stubFetch(fakeResponse({ ok: true, body: JSON.stringify({ revision: 3, publishedAt: "2026-10-27T17:00:00.000Z", document }) }));
      const client = newsApiClient("http://host/news", fetchImpl as unknown as typeof fetch);
      expect(await client.siteSettings()).toEqual({ revision: 3, document });
      expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://host/news/api/v2/site-settings");
    });

    it("a 404 (nothing published yet) is null", async () => {
      const fetchImpl = stubFetch(fakeResponse({ ok: false, status: 404, body: JSON.stringify({ error: "not found" }) }));
      expect(await newsApiClient("http://host", fetchImpl as unknown as typeof fetch).siteSettings()).toBeNull();
    });

    it("an empty 200 is a failure (rejects), not \"nothing published\"", async () => {
      const empty = stubFetch(fakeResponse({ ok: true, body: "" }));
      await expect(newsApiClient("http://host", empty as unknown as typeof fetch).siteSettings()).rejects.toThrow();
    });

    it("a 5xx or a malformed document rejects", async () => {
      await expect(newsApiClient("http://host", stubFetch(fakeResponse({ ok: false, status: 503, body: "" })) as unknown as typeof fetch).siteSettings()).rejects.toThrow(/503/);
      const malformed = stubFetch(fakeResponse({ ok: true, body: JSON.stringify({ revision: 1, publishedAt: "x", document: { footer: {} } }) }));
      await expect(newsApiClient("http://host", malformed as unknown as typeof fetch).siteSettings()).rejects.toThrow();
    });
  });
});
