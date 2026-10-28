import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractKeys, missingKeys, runCli } from "../scripts/archive-coverage-check";

const FIXTURE = `<!DOCTYPE html><html><body>
<a href="https://archive.news.gov.bc.ca/releases/news_releases_2020-2024/2026WLRS0042-000965.htm">x</a>
<a href="https://archive.news.gov.bc.ca/releases/news_releases_2020-2024/some-slug-style-key.htm">y</a>
<a href="https://archive.news.gov.bc.ca/releases/news_releases_2020-2024/2026WLRS0042-000965.htm">dup</a>
<a href="https://archive.news.gov.bc.ca/other/page.htm">not a release</a>
</body></html>`;

describe("archive coverage check", () => {
  it("extractKeys finds release keys once each, including slug-style keys", () => {
    expect(extractKeys(FIXTURE)).toEqual(["2026WLRS0042-000965", "some-slug-style-key"]);
  });

  it("missingKeys reports only keys the News API lacks, ignoring case", async () => {
    const known = new Set(["2026wlrs0042-000965"]);
    const fetchPosts = async (keys: string[]) => keys.filter((k) => known.has(k.toLowerCase())).map((key) => ({ key: key.toUpperCase() }));
    expect(await missingKeys(["2026WLRS0042-000965", "some-slug-style-key"], fetchPosts)).toEqual(["some-slug-style-key"]);
  });

  it("missingKeys splits 250 keys into 3 calls of at most 100", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `K${i}`);
    const sizes: number[] = [];
    const missing = await missingKeys(keys, async (batch) => (sizes.push(batch.length), []));
    expect(sizes).toEqual([100, 100, 50]);
    expect(missing).toHaveLength(250);
  });

  describe("runCli", () => {
    afterEach(() => vi.unstubAllGlobals());
    async function indexFile(html: string): Promise<string> {
      const f = join(await mkdtemp(join(tmpdir(), "cov-")), "index.htm");
      await writeFile(f, html);
      return f;
    }
    const run = async (args: string[]) => {
      const lines: string[] = [];
      return { code: await runCli(args, (l) => lines.push(l)), out: lines.join("\n") };
    };

    it("exits 0 when the API has every key, and 1 when one is missing", async () => {
      const f = await indexFile(FIXTURE);
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify([{ key: "2026wlrs0042-000965" }, { key: "some-slug-style-key" }])));
      expect((await run(["--news-api", "http://api", f])).code).toBe(0);
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify([{ key: "2026wlrs0042-000965" }])));
      const r = await run(["--news-api", "http://api", f]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("checked 2, missing 1");
    });

    it("exits 2, not 0, when the API answers 500", async () => {
      const f = await indexFile(FIXTURE);
      vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
      expect((await run(["--news-api", "http://api", f])).code).toBe(2);
    });

    it("exits 2 when a request fails or times out", async () => {
      const f = await indexFile(FIXTURE);
      vi.stubGlobal("fetch", async () => {
        throw new DOMException("timed out", "TimeoutError");
      });
      expect((await run(["--news-api", "http://api", f])).code).toBe(2);
    });

    it("exits 2 when an index lists no keys, even with other good sources", async () => {
      const good = await indexFile(FIXTURE);
      const empty = await indexFile("<html><body>Not Found</body></html>");
      vi.stubGlobal("fetch", async () => new Response("[]"));
      const r = await run(["--news-api", "http://api", good, empty]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("lists no release keys");
    });
  });
});
