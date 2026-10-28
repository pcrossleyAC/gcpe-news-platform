import { describe, expect, it } from "vitest";
import { extractKeys, missingKeys } from "../scripts/archive-coverage-check";

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
});
