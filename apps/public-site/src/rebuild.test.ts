import { describe, expect, it, vi } from "vitest";
import type { Tx } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createRebuildHandler, resyncPostPages, tryHome } from "./rebuild";
import type { NewsApiClient } from "./news-api-client";
import type { SiteStorage } from "./storage";
import type { PostDto } from "./render";

const site = { name: "BC Gov News", baseUrl: "https://news.example" };

function memoryStorage(): SiteStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async write(relPath, html) {
      files.set(relPath, html);
    },
    async remove(relPath) {
      files.delete(relPath);
    },
    async exists(relPath) {
      return files.has(relPath);
    },
    async read(relPath) {
      return files.get(relPath) ?? null;
    },
    async listDirs(relPath) {
      const prefix = `${relPath}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const seg = key.slice(prefix.length).split("/")[0];
        if (seg) names.add(seg);
      }
      return [...names];
    },
  };
}

const post: PostDto = {
  key: "K1",
  kind: "releases",
  publishDate: "2026-10-03T10:00:00-07:00",
  summary: null,
  location: null,
  ministryKeys: [],
  documents: [{ languageId: 4105, headline: "Headline", subheadline: null, detailsHtml: "<p>x</p>", contacts: [] }],
};

function envelope(data: unknown): EventEnvelope {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "site.rebuild_requested",
    version: 1,
    source: "news-api",
    aggregateId: "site",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    correlationId: "00000000-0000-0000-0000-000000000002",
    data,
  };
}

describe("createRebuildHandler", () => {
  it("writes the home page and a post page for pages [home, post:K1]", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async (key: string) => (key === "K1" ? post : null)),
      latestHome: vi.fn(async () => [post]),
      home: vi.fn(async () => ({ granville: null })),
    };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
  });

  it("removes the page for an unpublished post (getPost -> null)", async () => {
    const storage = memoryStorage();
    storage.files.set("releases/K1/index.html", "<p>stale</p>");
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => null), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
  });

  it("skips a path-escaping id and an unknown id without writing or throwing", async () => {
    const storage = memoryStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await expect(handler({} as Tx, envelope({ pages: ["post:../../x", "ministry:health"] }))).resolves.toBeUndefined();
    // Fix round 1: the run also writes the site-render-state marker (no post pages existed on
    // disk to resync, so that's the only file written).
    expect([...storage.files.keys()]).toEqual([".site-state.json"]);
    expect(newsApi.getPost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("ignores a post whose returned key doesn't match the requested key, leaving other files untouched (fix round 1, item 1)", async () => {
    const storage = memoryStorage();
    storage.files.set("index.html", "home-original");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => ({ ...post, key: ".." })), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    expect(storage.files.get("index.html")).toBe("home-original");
    // Fix round 1: the run also writes the marker — nothing else for the post:K1 page itself.
    expect([...storage.files.keys()].sort()).toEqual([".site-state.json", "index.html"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes at the requested key's path (not the API response's casing) when the keys only differ by case (fix round 1, item 1)", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => ({ ...post, key: "k1" })), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(storage.files.has("releases/k1/index.html")).toBe(false);
  });

  it("rejects when the News API is down, so the receiver 500s and the dispatcher retries", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => {
        throw new Error("News API down");
      }),
      latestHome: vi.fn(async () => []),
      home: vi.fn(async () => ({ granville: null })),
    };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await expect(handler({} as Tx, envelope({ pages: ["post:K1"] }))).rejects.toThrow("News API down");
  });

  // Important 1 (fix round 1): a home() failure must propagate — never swallowed and reported
  // as a success with no (or a stale) banner.
  it("propagates a home() failure instead of swallowing it, so the dispatcher retries", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => post),
      latestHome: vi.fn(async () => [post]),
      home: vi.fn(async () => {
        throw new Error("News API down");
      }),
    };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await expect(handler({} as Tx, envelope({ pages: ["home"] }))).rejects.toThrow("News API down");
    expect(storage.files.has("index.html")).toBe(false); // nothing written on failure
  });

  it("fetches home() once per run (not per page) and renders the banner on every page written", async () => {
    const storage = memoryStorage();
    const home = vi.fn(async () => ({ granville: "true" }));
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home };
    const handler = createRebuildHandler({ newsApi, storage, site, test: false });
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    expect(home).toHaveBeenCalledTimes(1);
    expect(storage.files.get("index.html")).toContain("blue-bridge-banner");
    expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");
  });

  it("a test site's pages carry the TEST-prefixed banner and the noindex meta", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
    const handler = createRebuildHandler({ newsApi, storage, site, test: true });
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    expect(storage.files.get("index.html")).toContain("TEST — ALERT:");
    expect(storage.files.get("index.html")).toContain("noindex");
    expect(storage.files.get("releases/K1/index.html")).toContain("TEST — ALERT:");
  });

  // CRITICAL (fix round 1): post pages are static files with the banner baked in — a
  // home-only rebuild must still re-render every post page already on disk when granville
  // flips, since the dispatcher otherwise only ever rebuilds the pages the event names.
  describe("resyncing existing post pages when the Blue Bridge/test state changes", () => {
    it("ON -> OFF: a home-only rebuild strips the banner from an existing post page", async () => {
      const storage = memoryStorage();
      const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      const handler = createRebuildHandler({ newsApi, storage, site, test: false });
      await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
      expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");

      newsApi.home = vi.fn(async () => ({ granville: null }));
      await handler({} as Tx, envelope({ pages: ["home"] }));
      expect(storage.files.get("releases/K1/index.html")).not.toContain("blue-bridge-banner");
    });

    it("OFF -> ON: a home-only rebuild adds the banner to an existing post page", async () => {
      const storage = memoryStorage();
      const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: null })) };
      const handler = createRebuildHandler({ newsApi, storage, site, test: false });
      await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
      expect(storage.files.get("releases/K1/index.html")).not.toContain("blue-bridge-banner");

      newsApi.home = vi.fn(async () => ({ granville: "true" }));
      await handler({} as Tx, envelope({ pages: ["home"] }));
      expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");
    });

    it("unchanged state: a later rebuild doesn't re-fetch/re-render posts not in its own pages", async () => {
      const storage = memoryStorage();
      const getPost = vi.fn(async () => post);
      const newsApi: NewsApiClient = { getPost, latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      const handler = createRebuildHandler({ newsApi, storage, site, test: false });
      await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
      expect(getPost).toHaveBeenCalledTimes(1);

      // Same granville, same test — a second, unrelated home-only rebuild must not touch K1.
      await handler({} as Tx, envelope({ pages: ["home"] }));
      expect(getPost).toHaveBeenCalledTimes(1); // still just the one call from the first run
    });

    // The daily age bump alone (granville unchanged, same "on") must never trigger a resync —
    // only on/off or test/production changing does.
    it("the banner's age ticking over a day doesn't by itself trigger a resync", async () => {
      const storage = memoryStorage();
      const getPost = vi.fn(async () => post);
      const newsApi: NewsApiClient = { getPost, latestHome: vi.fn(async () => [post]), home: vi.fn(async () => ({ granville: "true" })) };
      await resyncPostPages({ newsApi, storage, site }, { granvilleOn: true, test: false }, "ALERT: ...age of 77");
      storage.files.set("releases/K1/index.html", "<p>stale but unrelated to the marker check</p>");
      await resyncPostPages({ newsApi, storage, site }, { granvilleOn: true, test: false }, "ALERT: ...age of 78");
      expect(storage.files.get("releases/K1/index.html")).toBe("<p>stale but unrelated to the marker check</p>");
    });
  });
});

describe("tryHome", () => {
  it("returns home()'s result on success", async () => {
    const newsApi = { home: vi.fn(async () => ({ granville: "true" })) } as unknown as NewsApiClient;
    expect(await tryHome(newsApi)).toEqual({ granville: "true" });
  });

  it("never throws: logs and returns null on failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const newsApi = {
        home: vi.fn(async () => {
          throw new Error("News API down");
        }),
      } as unknown as NewsApiClient;
      expect(await tryHome(newsApi)).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("resyncPostPages", () => {
  it("re-renders every post key found on disk under releases/, skipping non-post entries", async () => {
    const storage = memoryStorage();
    storage.files.set("releases/K1/index.html", "<p>stale</p>");
    storage.files.set("releases/K2/index.html", "<p>stale</p>");
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async (key: string) => ({ ...post, key })),
      latestHome: vi.fn(async () => []),
      home: vi.fn(async () => ({ granville: "true" })),
    };
    await resyncPostPages({ newsApi, storage, site }, { granvilleOn: true, test: false }, "ALERT: banner text");
    expect(storage.files.get("releases/K1/index.html")).toContain("blue-bridge-banner");
    expect(storage.files.get("releases/K2/index.html")).toContain("blue-bridge-banner");
    expect(newsApi.getPost).toHaveBeenCalledTimes(2);
  });

  it("a missing marker always counts as changed, even against an all-off state (writes the marker the first time)", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => []), home: vi.fn(async () => ({ granville: null })) };
    await resyncPostPages({ newsApi, storage, site }, { granvilleOn: false, test: false }, null);
    expect(storage.files.get(".site-state.json")).toBe(JSON.stringify({ granvilleOn: false, test: false }));
  });
});
