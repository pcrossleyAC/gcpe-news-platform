import type { PostDto } from "./render";

export interface NewsApiClient {
  getPost(key: string): Promise<PostDto | null>;
  latestHome(count: number): Promise<PostDto[]>;
}

export function newsApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): NewsApiClient {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(new URL(path, baseUrl), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`News API ${res.status} for ${path}`);
    const text = await res.text();
    return text.trim() === "" ? null : JSON.parse(text); // the v1 API answers "not found" with an empty 200
  };
  return {
    getPost: async (key) => (await get(`/api/Posts/${encodeURIComponent(key)}?api-version=1.0`)) as PostDto | null,
    latestHome: async (count) => ((await get(`/api/Posts/Latest/home/default?api-version=1.0&count=${count}`)) as PostDto[] | null) ?? [],
  };
}
