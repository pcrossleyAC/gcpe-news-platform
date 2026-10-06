import { describe, expect, it, vi } from "vitest";
import { newsApiClient } from "./news-api-client";

function fakeResponse(opts: { ok: boolean; status?: number; body: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    text: async () => opts.body,
  } as unknown as Response;
}

function stubFetch(response: Response) {
  return vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(response));
}

describe("newsApiClient", () => {
  it("treats an empty 200 body as null (not found)", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    expect(await client.getPost("K1")).toBeNull();
  });

  it("treats a whitespace-only 200 body as null", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "   \n  " }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    expect(await client.getPost("K1")).toBeNull();
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: false, status: 500, body: "boom" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    await expect(client.getPost("K1")).rejects.toThrow(/500/);
  });

  it("throws on a non-JSON 200 body", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "not json" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    await expect(client.getPost("K1")).rejects.toThrow();
  });

  it("builds URLs against a root base", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "null" }));
    const client = newsApiClient("http://host", fetchImpl as unknown as typeof fetch);
    await client.getPost("K1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://host/api/Posts/K1?api-version=1.0");
    await client.latestHome(10);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("http://host/api/Posts/Latest/home/default?api-version=1.0&count=10");
  });

  // Fix round 1, item 6: new URL("/api/...", "http://host/news/") discards the "/news" prefix
  // because a leading slash makes the second argument absolute relative to the origin.
  it("keeps a path prefix when NEWS_API_URL has one, with a trailing slash", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "null" }));
    const client = newsApiClient("http://host/news/", fetchImpl as unknown as typeof fetch);
    await client.getPost("K1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://host/news/api/Posts/K1?api-version=1.0");
  });

  it("keeps a path prefix when NEWS_API_URL has no trailing slash", async () => {
    const fetchImpl = stubFetch(fakeResponse({ ok: true, body: "null" }));
    const client = newsApiClient("http://host/news", fetchImpl as unknown as typeof fetch);
    await client.getPost("K1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://host/news/api/Posts/K1?api-version=1.0");
  });
});
