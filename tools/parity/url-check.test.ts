import { describe, expect, it } from "vitest";
import { checkUrls, formatSummary, parseList } from "./url-check";

type Reply = { status: number; location?: string };
function fakeFetch(map: Record<string, Reply>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const r = map[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return new Response(null, { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as typeof fetch;
}

describe("checkUrls", () => {
  it("200 passes; 404 fails with its status", async () => {
    const f = fakeFetch({ "https://x.test/a": { status: 200 }, "https://x.test/b": { status: 404 } });
    const [a, b] = await checkUrls("https://x.test", ["/a", "/b"], f);
    expect(a).toMatchObject({ path: "/a", status: 200, ok: true });
    expect(b).toMatchObject({ path: "/b", status: 404, ok: false });
  });

  it("a 301 to a 200 passes and records the location", async () => {
    const f = fakeFetch({
      "https://x.test/old": { status: 301, location: "/new" },
      "https://x.test/new": { status: 200 },
    });
    const [r] = await checkUrls("https://x.test", ["/old"], f);
    expect(r).toMatchObject({ status: 301, location: "/new", ok: true });
  });

  it("301 -> 301 fails as a redirect chain", async () => {
    const f = fakeFetch({
      "https://x.test/a": { status: 301, location: "/b" },
      "https://x.test/b": { status: 301, location: "/c" },
    });
    const [r] = await checkUrls("https://x.test", ["/a"], f);
    expect(r).toMatchObject({ ok: false, reason: "redirect chain" });
  });

  it("a 301 to a 404 fails", async () => {
    const f = fakeFetch({
      "https://x.test/a": { status: 301, location: "/gone" },
      "https://x.test/gone": { status: 404 },
    });
    const [r] = await checkUrls("https://x.test", ["/a"], f);
    expect(r?.ok).toBe(false);
  });

  it("a 301 to another host passes without fetching it", async () => {
    const seen: string[] = [];
    const f = fakeFetch({ "https://x.test/a": { status: 301, location: "https://other.example/z" } }, seen);
    const [r] = await checkUrls("https://x.test", ["/a"], f);
    expect(r).toMatchObject({ ok: true, location: "https://other.example/z" });
    expect(seen).toEqual(["https://x.test/a"]);
  });

  it("preserves the query string when following a relative Location", async () => {
    const seen: string[] = [];
    const f = fakeFetch(
      {
        "https://x.test/a": { status: 301, location: "/x?q=a b" },
        "https://x.test/x?q=a%20b": { status: 200 },
      },
      seen,
    );
    const [r] = await checkUrls("https://x.test", ["/a"], f);
    expect(r?.ok).toBe(true);
    expect(seen[1]).toBe("https://x.test/x?q=a%20b");
  });

  it("a redirect without a Location fails with its reason", async () => {
    const f = fakeFetch({ "https://x.test/a": { status: 302 } });
    const [r] = await checkUrls("https://x.test", ["/a"], f);
    expect(r).toMatchObject({ status: 302, location: null, ok: false, reason: "redirect without Location" });
  });

  it("a network error on one path is recorded and the rest of the list still runs", async () => {
    const f = fakeFetch({ "https://x.test/b": { status: 200 } }); // /a is unknown, so it throws
    const results = await checkUrls("https://x.test", ["/a", "/b"], f);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ path: "/a", status: 0, ok: false });
    expect(results[0]?.reason).toMatch(/^fetch failed: /);
    expect(results[1]).toMatchObject({ path: "/b", ok: true });
  });

  it("aborts a path that hangs past the timeout", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    const [r] = await checkUrls("https://x.test", ["/slow"], hang, 50);
    expect(r).toMatchObject({ ok: false, status: 0 });
    expect(r?.reason).toMatch(/^fetch failed: /);
  });
});

describe("sections", () => {
  it("parseList assigns sections", () => {
    const text = "# comment\n/a\n# section: feeds\n/feed\n\n# section: posts\n/p\n";
    expect(parseList(text)).toEqual([
      { path: "/a", section: "default" },
      { path: "/feed", section: "feeds" },
      { path: "/p", section: "posts" },
    ]);
  });

  it("a result carries its section; main's summary counts per section", async () => {
    const f = fakeFetch({
      "https://x.test/a": { status: 200 },
      "https://x.test/b": { status: 404 },
      "https://x.test/c": { status: 200 },
    });
    const results = await checkUrls(
      "https://x.test",
      [
        { path: "/a", section: "feeds" },
        { path: "/b", section: "feeds" },
        { path: "/c", section: "posts" },
      ],
      f,
    );
    expect(results.map((r) => r.section)).toEqual(["feeds", "feeds", "posts"]);
    expect(formatSummary(results)).toEqual(["feeds: 1/2 passed", "posts: 1/1 passed", "2/3 passed"]);
  });
});
