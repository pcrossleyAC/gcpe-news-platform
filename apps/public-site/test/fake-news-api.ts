import type { PostDto } from "../src/dto";
import type { NewsApiClient } from "../src/news-api-client";
import { ministry } from "./fixtures";

/**
 * An in-memory `NewsApiClient`, shared by `builder.test.ts`, `rebuild.test.ts` and
 * `self-heal.test.ts` — one place that knows how to answer every method from a plain map of
 * posts, so a test can add or remove posts through the returned `posts` map (and inspect
 * `calls` to assert which News API calls a run actually made) instead of re-deriving responses
 * from a closed-over literal in each file.
 */
export function fakeNewsApi(posts = new Map<string, PostDto>()): NewsApiClient & { posts: Map<string, PostDto>; calls: string[] } {
  const calls: string[] = [];
  const published = () => [...posts.values()].sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const inCat = (field: "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys", key: string) => published().filter((p) => (p[field] ?? []).some((k) => k.toLowerCase() === key.toLowerCase()));
  return {
    posts,
    calls,
    getPost: async (key) => { calls.push(`getPost:${key}`); return posts.get(key) ?? null; },
    latestHome: async (n) => published().slice(0, n),
    latest: async (kind, key, n) => inCat(({ ministries: "ministryKeys", sectors: "sectorKeys", themes: "themeKeys", tags: "tagKeys" } as const)[kind], key).slice(0, n),
    home: async () => ({ granville: null, topPostKey: null, featurePostKey: null }),
    postsByKeys: async (keys) => keys.map((k) => posts.get(k)).filter((p): p is PostDto => !!p),
    ministries: async () => [ministry({ key: "health", name: "Health" }), ministry({ key: "finance", name: "Finance" })],
    ministry: async (key) => (["health", "finance"].includes(key.toLowerCase()) ? ministry({ key: key.toLowerCase(), name: key }) : null),
    minister: async () => null,
    categories: async () => [],
    category: async (_kind, key) => (key === "covid-19" ? { key, kind: "tags", name: "COVID-19", isActive: true, topPostKey: null, featurePostKey: null } : null),
    slides: async () => [],
    resourceLinks: async () => [],
    related: async () => [],
    postKeys: async (kind) => [...posts.values()].filter((p) => p.kind === kind).map((p) => p.key),
  };
}
