import { describe, expect, it } from "vitest";
import { buildLegacyUrlList, extractPaths } from "./legacy-url-list";

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

describe("extractPaths", () => {
  it("decodes named and numeric entities before parsing, keeping the search query", () => {
    const html = `<a href="/search?q=a&amp;b=1">1</a><a href="/search?q=x&#38;y=2">2</a><a href="&#x2F;ministries&#x2F;health">3</a><a href="/ministries/it&#39;s">4</a>`;
    expect(extractPaths(html)).toEqual(["/search?q=a", "/search?q=x", "/ministries/health", "/ministries/it's"]);
  });

  it("drops protocol-relative other hosts, data: URLs and lookalike hosts", () => {
    const html = `<a href="//evil.example/a">1</a><a href="data:text/html,x">2</a><a href="https://news.gov.bc.ca.evil.example/a">3</a>
<a href="https://evilnews.gov.bc.ca/a">4</a><a href="//news.gov.bc.ca/ok">5</a><a href="https://news.gov.bc.ca@evil.example/a">6</a>`;
    expect(extractPaths(html)).toEqual(["/ok"]);
  });

  it("strips queries except q on /search", () => {
    const html = `<a href="/search?q=housing&amp;page=2">1</a><a href="/Search?Ministry=Health">2</a><a href="/releases/x?utm=1">3</a>`;
    expect(extractPaths(html)).toEqual(["/search?q=housing", "/Search", "/releases/x"]);
  });
});

describe("buildLegacyUrlList sections", () => {
  it("routes homepage /releases/<key> hrefs to posts, not nav", async () => {
    const out = await buildLegacyUrlList(async (p) => (p === "/" ? `<a href="/releases/2026AA0009-000009">r</a><a href="/subscribe">s</a>` : p === "/connect" ? "" : ""), { posts: 5 });
    const at = (name: string) => out.indexOf(`# section: ${name}`);
    const idx = out.indexOf("/releases/2026AA0009-000009");
    expect(idx).toBeGreaterThan(at("posts"));
    expect(idx).toBeLessThan(at("post-variants"));
    expect(out.slice(at("nav"), at("feeds"))).not.toContain("/releases/2026AA0009-000009");
  });

  it("adds variants for only the first 10 posts", async () => {
    const links = Array.from({ length: 15 }, (_, i) => `<a href="/releases/2026AA${String(i).padStart(4, "0")}-000001">p</a>`).join("");
    const out = await buildLegacyUrlList(async (p) => (p.startsWith("/sitemap") ? links : ""), { posts: 15 });
    const variants = out.slice(out.indexOf("# section: post-variants") + 1);
    expect(variants).toHaveLength(20);
  });
});
