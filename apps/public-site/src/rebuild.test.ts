import { describe, expect, it, vi } from "vitest";
import type { Tx } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createRebuildHandler } from "./rebuild";
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
    };
    const handler = createRebuildHandler({ newsApi, storage, site });
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
  });

  it("removes the page for an unpublished post (getPost -> null)", async () => {
    const storage = memoryStorage();
    storage.files.set("releases/K1/index.html", "<p>stale</p>");
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => null), latestHome: vi.fn(async () => []) };
    const handler = createRebuildHandler({ newsApi, storage, site });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
  });

  it("skips a path-escaping id and an unknown id without writing or throwing", async () => {
    const storage = memoryStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => post), latestHome: vi.fn(async () => []) };
    const handler = createRebuildHandler({ newsApi, storage, site });
    await expect(handler({} as Tx, envelope({ pages: ["post:../../x", "ministry:health"] }))).resolves.toBeUndefined();
    expect(storage.files.size).toBe(0);
    expect(newsApi.getPost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("ignores a post whose returned key doesn't match the requested key, leaving other files untouched (fix round 1, item 1)", async () => {
    const storage = memoryStorage();
    storage.files.set("index.html", "home-original");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => ({ ...post, key: ".." })), latestHome: vi.fn(async () => []) };
    const handler = createRebuildHandler({ newsApi, storage, site });
    await handler({} as Tx, envelope({ pages: ["post:K1"] }));
    expect(storage.files.get("index.html")).toBe("home-original");
    expect(storage.files.size).toBe(1); // nothing written for the post:K1 page
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes at the requested key's path (not the API response's casing) when the keys only differ by case (fix round 1, item 1)", async () => {
    const storage = memoryStorage();
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => ({ ...post, key: "k1" })), latestHome: vi.fn(async () => []) };
    const handler = createRebuildHandler({ newsApi, storage, site });
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
    };
    const handler = createRebuildHandler({ newsApi, storage, site });
    await expect(handler({} as Tx, envelope({ pages: ["post:K1"] }))).rejects.toThrow("News API down");
  });
});
