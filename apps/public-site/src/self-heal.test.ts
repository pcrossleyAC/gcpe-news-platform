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

  // Fix round 1: writes post pages first and index.html LAST, so a failure partway through
  // leaves index.html missing — the exists() check at the top of the function means the next
  // start will retry everything, instead of seeing index.html and wrongly concluding "already
  // healed" with some post pages never written.
  it("writes post pages before index.html, so a mid-rebuild failure leaves index.html missing for a retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "self-heal-"));
    made.push(root);
    const real = fsStorage(root);
    const writes: string[] = [];
    const storage = {
      ...real,
      async write(relPath: string, html: string) {
        writes.push(relPath);
        if (relPath === "releases/K2/index.html") throw new Error("disk full");
        await real.write(relPath, html);
      },
    };
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => null),
      latestHome: vi.fn(async () => [postA, postB]),
    };

    await expect(selfHeal({ newsApi, storage, site })).rejects.toThrow("disk full");
    // K1's page (written before K2's failure) did land, but index.html must not have.
    expect(writes).toEqual(["releases/K1/index.html", "releases/K2/index.html"]);
    expect(await real.exists("index.html")).toBe(false);
    expect(await real.exists("releases/K1/index.html")).toBe(true);
  });
});
