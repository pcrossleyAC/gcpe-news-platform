import type { StoredSiteSettings } from "@gcpe/site-settings";
import type { CategoryDto, GovernmentTermsDto, PostDto, SlideDto } from "../src/dto";
import type { NewsApiClient } from "../src/news-api-client";
import { ministry } from "./fixtures";

/**
 * An in-memory `NewsApiClient`, shared by `builder.test.ts`, `rebuild.test.ts` and
 * `self-heal.test.ts` — one place that knows how to answer every method from a plain map of
 * posts, so a test can add or remove posts through the returned `posts` map (and inspect
 * `calls` to assert which News API calls a run actually made) instead of re-deriving responses
 * from a closed-over literal in each file.
 */
export type FakeNewsApi = NewsApiClient & {
  posts: Map<string, PostDto>;
  calls: string[];
  settings: { revision: number; document: StoredSiteSettings } | null;
  /** What `categories("sectors")` answers (home's News by Sector); other kinds answer []. */
  sectors: CategoryDto[];
  /** What `slides()` answers (home's carousel band). */
  slideList: SlideDto[];
  terms: GovernmentTermsDto | null;
  successors: Record<string, string>;
};

export function fakeNewsApi(posts = new Map<string, PostDto>()): FakeNewsApi {
  const calls: string[] = [];
  const published = () => [...posts.values()].sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const inCat = (field: "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys", key: string) => published().filter((p) => (p[field] ?? []).some((k) => k.toLowerCase() === key.toLowerCase()));
  const api: FakeNewsApi = {
    posts,
    calls,
    /** What `siteSettings()` answers: null is the News API's 404 (nothing published yet). */
    settings: null,
    sectors: [],
    slideList: [],
    /** What `governmentTerms()` answers: null is the News API's 404. */
    terms: null,
    /** What `ministrySuccessors()` answers. */
    successors: {},
    getPost: async (key) => { calls.push(`getPost:${key}`); return posts.get(key) ?? null; },
    latestHome: async (n) => published().slice(0, n),
    latest: async (kind, key, n) => inCat(({ ministries: "ministryKeys", sectors: "sectorKeys", themes: "themeKeys", tags: "tagKeys" } as const)[kind], key).slice(0, n),
    home: async () => ({ granville: null, topPostKey: null, featurePostKey: null }),
    postsByKeys: async (keys) => keys.map((k) => posts.get(k)).filter((p): p is PostDto => !!p),
    ministries: async () => [ministry({ key: "health", name: "Health" }), ministry({ key: "finance", name: "Finance" })],
    ministry: async (key) => (["health", "finance"].includes(key.toLowerCase()) ? ministry({ key: key.toLowerCase(), name: key }) : null),
    ministryProfiles: async () => [],
    minister: async () => null,
    categories: async (kind) => (kind === "sectors" ? api.sectors : []),
    category: async (_kind, key) => (key === "covid-19" ? { key, kind: "tags", name: "COVID-19", isActive: true, topPostKey: null, featurePostKey: null } : null),
    slides: async () => api.slideList,
    resourceLinks: async () => [],
    related: async () => [],
    postKeys: async (kind) => published().filter((p) => p.kind === kind).map((p) => p.key),
    siteSettings: async () => { calls.push("siteSettings"); return api.settings; },
    governmentTerms: async () => { calls.push("governmentTerms"); return api.terms; },
    ministrySuccessors: async () => { calls.push("ministrySuccessors"); return api.successors; },
  };
  return api;
}
