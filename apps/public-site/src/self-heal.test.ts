import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { NewsApiClient } from "./news-api-client";
import type { PostDto } from "./render";
import { selfHeal } from "./self-heal";
import { fsStorage } from "./storage";

const site = { name: "BC Gov News", baseUrl: "https://news.example" };

const postA: PostDto = {
  key: "K1",
  kind: "releases",
  publishDate: "2026-10-03T10:00:00-07:00",
  summary: null,
  location: null,
  ministryKeys: [],
  documents: [{ languageId: 4105, headline: "Headline A", subheadline: null, detailsHtml: "<p>a</p>", contacts: [] }],
};
const postB: PostDto = { ...postA, key: "K2", documents: [{ ...postA.documents[0]!, headline: "Headline B" }] };

describe("selfHeal", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
  });

  it("rebuilds the home page and every post when index.html is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "self-heal-"));
    made.push(root);
    const storage = fsStorage(root);
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => null),
      latestHome: vi.fn(async () => [postA, postB]),
    };

    const result = await selfHeal({ newsApi, storage, site });
    expect(result).toEqual({ rebuilt: 2 });
    expect(await readFile(join(root, "index.html"), "utf8")).toContain("Headline A");
    expect(await readFile(join(root, "releases", "K1", "index.html"), "utf8")).toContain("Headline A");
    expect(await readFile(join(root, "releases", "K2", "index.html"), "utf8")).toContain("Headline B");

    const second = await selfHeal({ newsApi, storage, site });
    expect(second).toBeNull();
    expect(newsApi.latestHome).toHaveBeenCalledTimes(1);
  });

  it("rejects when the News API is down, so the caller can log it", async () => {
    const root = await mkdtemp(join(tmpdir(), "self-heal-"));
    made.push(root);
    const storage = fsStorage(root);
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => null),
      latestHome: vi.fn(async () => {
        throw new Error("News API down");
      }),
    };
    await expect(selfHeal({ newsApi, storage, site })).rejects.toThrow("News API down");
  });
});
