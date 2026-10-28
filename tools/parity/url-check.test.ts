import { describe, expect, it } from "vitest";
import { checkUrls } from "./url-check";

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
});
