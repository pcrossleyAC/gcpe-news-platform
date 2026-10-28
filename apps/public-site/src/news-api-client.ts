import { siteSettingsSchema } from "@gcpe/site-settings";
import { z } from "zod";
import type { CategoryDto, HomeDto, MinisterDto, MinistryDto, PostDto, RelatedPost, ResourceLinkDto, SiteSettingsDto, SlideDto } from "./dto";
import type { CategoryKind } from "./site-paths";

export interface NewsApiClient {
  getPost(key: string): Promise<PostDto | null>;
  latestHome(count: number): Promise<PostDto[]>;
  latest(kind: CategoryKind, key: string, count: number): Promise<PostDto[]>;
  /** The home settings News API already projects (plan 3d tasks 1–3) — used here for
   * Project Blue Bridge's `granville` (plan 3d task 4) and the home page's top/feature posts. */
  home(): Promise<HomeDto>;
  postsByKeys(keys: string[]): Promise<PostDto[]>;
  ministries(): Promise<MinistryDto[]>;
  ministry(key: string): Promise<MinistryDto | null>;
  minister(key: string): Promise<MinisterDto | null>;
  categories(kind: Exclude<CategoryKind, "ministries">): Promise<CategoryDto[]>;
  category(kind: Exclude<CategoryKind, "ministries">, key: string): Promise<CategoryDto | null>;
  slides(): Promise<SlideDto[]>;
  resourceLinks(): Promise<ResourceLinkDto[]>;
  related(key: string): Promise<RelatedPost[]>;
  postKeys(postKind: string): Promise<string[]>;
  /** `GET /api/v2/site-settings`: the published revision and document, or null on a 404 (nothing
   * published yet). A malformed document rejects, like a network failure. */
  siteSettings(): Promise<SiteSettingsDto | null>;
}

/** Structural check only (the document was validated when NRMS published it): enough that a
 * render can rely on every section's shape. */
const siteSettingsBodySchema = z.object({ revision: z.number().int(), document: siteSettingsSchema });

export function newsApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): NewsApiClient {
  // A leading slash on the second argument to `new URL` makes it absolute relative to the
  // origin, discarding any path prefix baseUrl carries (e.g. "http://host/news/" loses
  // "/news"). Ensuring a trailing slash on the base and using relative paths (no leading
  // slash) below makes `new URL` join onto the base path instead of replacing it.
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`News API ${res.status} for ${path}`);
    const text = await res.text();
    return text.trim() === "" ? null : JSON.parse(text); // the v1 API answers "not found" with an empty 200
  };
  /** Like `get`, but a 404 (an unknown category, or a post unpublished meanwhile) is `null`
   * rather than a thrown error — the caller then treats it the same as v1's empty-200 "not
   * found", so a category page or related-posts call never blocks on it. */
  const getOr404 = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`News API ${res.status} for ${path}`);
    const text = await res.text();
    return text.trim() === "" ? null : JSON.parse(text);
  };

  const v1 = "api-version=1.0";
  const enc = encodeURIComponent;
  const LATEST_PATH: Record<CategoryKind | "home", string> = { home: "home", ministries: "ministries", sectors: "sectors", themes: "themes", tags: "tags" };
  const LIST_PATH = { sectors: "Sectors", themes: "Themes", tags: "Tags" } as const;
  return {
    getPost: async (key) => (await get(`api/Posts/${enc(key)}?${v1}`)) as PostDto | null,
    latestHome: async (count) => ((await get(`api/Posts/Latest/home/default?${v1}&count=${count}`)) as PostDto[] | null) ?? [],
    latest: async (kind, key, count) => ((await getOr404(`api/Posts/Latest/${LATEST_PATH[kind]}/${enc(key)}?${v1}&count=${count}`)) as PostDto[] | null) ?? [],
    home: async () => (await get(`api/Home?${v1}`)) as HomeDto,
    postsByKeys: async (keys) => (keys.length ? (((await get(`api/Posts?${v1}&postKeys=${enc(keys.join(","))}`)) as PostDto[] | null) ?? []) : []),
    ministries: async () => ((await get(`api/Ministries?${v1}`)) as MinistryDto[] | null) ?? [],
    ministry: async (key) => (await get(`api/Ministries/${enc(key)}?${v1}`)) as MinistryDto | null,
    minister: async (key) => (await get(`api/Ministries/${enc(key)}/Minister?${v1}`)) as MinisterDto | null,
    categories: async (kind) => ((await get(`api/${LIST_PATH[kind]}?${v1}`)) as CategoryDto[] | null) ?? [],
    category: async (kind, key) => (await get(`api/${LIST_PATH[kind]}/${enc(key)}?${v1}`)) as CategoryDto | null,
    slides: async () => (((await get("api/v2/slides")) as { slides: SlideDto[] } | null)?.slides ?? []),
    resourceLinks: async () => ((await get(`api/ResourceLinks?${v1}`)) as ResourceLinkDto[] | null) ?? [],
    related: async (key) => {
      const body = (await getOr404(`api/v2/posts/${enc(key)}/related`)) as { results: { key: string; headline: string; publishDate: string }[] } | null;
      return (body?.results ?? []).map((r) => ({ key: r.key, headline: r.headline, publishDate: r.publishDate }));
    },
    siteSettings: async () => {
      const body = await getOr404("api/v2/site-settings");
      if (body === null) return null;
      const { revision, document } = siteSettingsBodySchema.parse(body);
      return { revision, document };
    },
    postKeys: async (postKind) => (((await get(`api/Posts/Keys/home/default?${v1}&postKind=${enc(postKind)}`)) as { key: string }[] | null) ?? []).map((r) => r.key),
  };
}
