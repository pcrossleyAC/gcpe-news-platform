import { describe, expect, it } from "vitest";
import { buildLegacyUrlList } from "./legacy-url-list";

const HOME = `<a href="/ministries/health">H</a><a href="https://news.gov.bc.ca/ministries/health">dup</a>
<a href="/sectors/economy">E</a><a href="/tags/housing">T</a>
<a href="javascript:void(0)">x</a><a href="mailto:a@b.ca">m</a><a href="https://example.com/ministries/evil">o</a>
<a href="/subscribe">S</a><a href="#top">top</a>`;
const CONNECT = `<a href="/feed">f</a><a href="/ministries/health/feed/atom">f2</a><a href="https://other.example/feed">no</a>`;
const SITEMAP = `<a href="/releases/2026AA0001-000001">1</a><a href="/releases/2026AA0002-000002">2</a>
<a href="/releases/2026AA0001-000001">dup</a>`;

function fetcher(seen: string[] = []) {
  return async (path: string) => {
    seen.push(path);
    if (path === "/") return HOME;
    if (path === "/connect") return CONNECT;
    if (path.startsWith("/sitemap/html")) return SITEMAP;
    throw new Error(`unexpected ${path}`);
  };
}

describe("buildLegacyUrlList", () => {
  it("keeps only news.gov.bc.ca paths, dedupes, and drops javascript: and mailto: hrefs", async () => {
    const out = await buildLegacyUrlList(fetcher(), { posts: 150 });
    const text = out.join("\n");
    expect(out).toContain("/ministries/health");
    expect(out.filter((l) => l === "/ministries/health")).toHaveLength(1);
    expect(out).toContain("/sectors/economy");
    expect(out).toContain("/tags/housing");
    expect(out).toContain("/subscribe");
    expect(out).toContain("/feed");
    expect(out).toContain("/ministries/health/feed/atom");
    expect(out).toContain("/releases/2026AA0001-000001");
    expect(out).toContain("/stories/2026AA0001-000001");
    expect(out).toContain("/releases/2026aa0001-000001");
    expect(text).not.toMatch(/javascript|mailto|example|#top/);
    expect(new Set(out.filter((l) => !l.startsWith("#"))).size).toBe(out.filter((l) => !l.startsWith("#")).length);
    for (const s of ["nav", "feeds", "posts", "post-variants"]) expect(out).toContain(`# section: ${s}`);
  });

  it("makes at most 4 fetches", async () => {
    const seen: string[] = [];
    await buildLegacyUrlList(fetcher(seen), { posts: 150 });
    expect(seen).toEqual(["/", "/connect", "/sitemap/html?count=150"]);
    expect(seen.length).toBeLessThanOrEqual(4);
  });
});
