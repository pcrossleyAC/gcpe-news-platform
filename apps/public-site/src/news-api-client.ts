import type { PostDto } from "./render";

export interface NewsApiClient {
  getPost(key: string): Promise<PostDto | null>;
  latestHome(count: number): Promise<PostDto[]>;
  /** The home settings News API already projects (plan 3d tasks 1–3) — used here only for
   * Project Blue Bridge's `granville` (plan 3d task 4). */
  home(): Promise<{ granville: string | null }>;
}

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
  return {
    getPost: async (key) => (await get(`api/Posts/${encodeURIComponent(key)}?api-version=1.0`)) as PostDto | null,
    latestHome: async (count) => ((await get(`api/Posts/Latest/home/default?api-version=1.0&count=${count}`)) as PostDto[] | null) ?? [],
    home: async () => (await get(`api/Home?api-version=1.0`)) as { granville: string | null },
  };
}
