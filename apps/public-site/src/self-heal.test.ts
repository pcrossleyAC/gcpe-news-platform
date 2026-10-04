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
      home: vi.fn(async () => ({ granville: null })),
    };

    const result = await selfHeal({ newsApi, storage, site, test: false });
    expect(result).toEqual({ rebuilt: 2 });
    expect(await readFile(join(root, "index.html"), "utf8")).toContain("Headline A");
    expect(await readFile(join(root, "releases", "K1", "index.html"), "utf8")).toContain("Headline A");
    expect(await readFile(join(root, "releases", "K2", "index.html"), "utf8")).toContain("Headline B");

    const second = await selfHeal({ newsApi, storage, site, test: false });
    expect(second).toBeNull();
    expect(newsApi.latestHome).toHaveBeenCalledTimes(1);
  });

  it("caps the home page listing at the normal home count, while still rebuilding every fetched post page", async () => {
    const root = await mkdtemp(join(tmpdir(), "self-heal-"));
    made.push(root);
    const storage = fsStorage(root);
    const many: PostDto[] = Array.from({ length: 12 }, (_, i) => ({
      ...postA,
      key: `K${i + 1}`,
      documents: [{ ...postA.documents[0]!, headline: `Headline ${i + 1}` }],
    }));
    const newsApi: NewsApiClient = {
      getPost: vi.fn(async () => null),
      latestHome: vi.fn(async () => many),
      home: vi.fn(async () => ({ granville: null })),
    };

    const result = await selfHeal({ newsApi, storage, site, test: false });
    expect(result).toEqual({ rebuilt: 12 });
    const home = await readFile(join(root, "index.html"), "utf8");
    for (let i = 1; i <= 10; i++) expect(home).toContain(`Headline ${i}`);
    expect(home).not.toContain("Headline 11");
    expect(home).not.toContain("Headline 12");
    // Every fetched post still gets its own page, even past the home-page count.
    expect(await readFile(join(root, "releases", "K11", "index.html"), "utf8")).toContain("Headline 11");
    expect(await readFile(join(root, "releases", "K12", "index.html"), "utf8")).toContain("Headline 12");
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
      home: vi.fn(async () => ({ granville: null })),
    };
    await expect(selfHeal({ newsApi, storage, site, test: false })).rejects.toThrow("News API down");
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
      home: vi.fn(async () => ({ granville: null })),
    };

    await expect(selfHeal({ newsApi, storage, site, test: false })).rejects.toThrow("disk full");
    // K1's page (written before K2's failure) did land, but index.html must not have.
    expect(writes).toEqual(["releases/K1/index.html", "releases/K2/index.html"]);
    expect(await real.exists("index.html")).toBe(false);
    expect(await real.exists("releases/K1/index.html")).toBe(true);
  });

  // Plan 3d task 4.
  it("fetches home() once for the whole run and renders the Blue Bridge banner on every page", async () => {
    const root = await mkdtemp(join(tmpdir(), "self-heal-"));
    made.push(root);
    const storage = fsStorage(root);
    const home = vi.fn(async () => ({ granville: "true" }));
    const newsApi: NewsApiClient = { getPost: vi.fn(async () => null), latestHome: vi.fn(async () => [postA, postB]), home };

    await selfHeal({ newsApi, storage, site, test: false });
    expect(home).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "index.html"), "utf8")).toContain("blue-bridge-banner");
    expect(await readFile(join(root, "releases", "K1", "index.html"), "utf8")).toContain("blue-bridge-banner");
  });

  it("a home() failure never fails self-heal — it renders with no banner", async () => {
    const root = await mkdtemp(join(tmpdir(), "self-heal-"));
    made.push(root);
    const storage = fsStorage(root);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const newsApi: NewsApiClient = {
        getPost: vi.fn(async () => null),
        latestHome: vi.fn(async () => [postA]),
        home: vi.fn(async () => {
          throw new Error("News API down");
        }),
      };
      const result = await selfHeal({ newsApi, storage, site, test: false });
      expect(result).toEqual({ rebuilt: 1 });
      expect(await readFile(join(root, "index.html"), "utf8")).not.toContain("blue-bridge-banner");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
