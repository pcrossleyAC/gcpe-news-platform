import { describe, expect, it } from "vitest";
import { ROBOTS_BLOCKED, thresholdFailures } from "../scripts/site-quality";

const ok = { performance: 86, accessibility: 100, "best-practices": 100, seo: 92 };
const lhr = (crawlable: number) => ({ audits: { "is-crawlable": { score: crawlable } } });

describe("site-quality: robots-blocked pages", () => {
  it("/search/ and the subscribe pages are what robots.txt blocks on purpose (news.gov's own Disallows)", () => {
    expect([...ROBOTS_BLOCKED]).toEqual(["/search/", "/subscribe/", "/subscribe/manage/"]);
  });

  it("a blocked page skips the SEO threshold but keeps the others", () => {
    expect(thresholdFailures("/search/", { ...ok, seo: 61 }, lhr(0))).toEqual([]);
    expect(thresholdFailures("/search/", { ...ok, seo: 61, performance: 70 }, lhr(0))).toEqual(["/search/: performance 70 < 80"]);
  });

  it("a blocked page that is no longer blocked fails", () => {
    expect(thresholdFailures("/search/", ok, lhr(1))).toEqual(["/search/: expected robots.txt to block it (is-crawlable should fail)"]);
  });

  it("any other page still needs SEO 90", () => {
    expect(thresholdFailures("/", { ...ok, seo: 61 }, lhr(1))).toEqual(["/: seo 61 < 90"]);
  });
});
