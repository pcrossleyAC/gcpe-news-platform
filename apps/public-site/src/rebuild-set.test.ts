import { describe, expect, it } from "vitest";
import { dependentPages, membershipOf } from "./rebuild-set";

const post = { publishDate: "2026-10-03T10:00:00-07:00", ministryKeys: ["Health"], sectorKeys: ["economy"], themeKeys: [], tagKeys: ["covid-19", "bad key"] };

describe("membershipOf", () => {
  it("takes the BC month from the offset date and lowercased, valid category tokens", () => {
    expect(membershipOf(post)).toEqual({ month: "2026-10", categories: ["ministries:health", "sectors:economy", "tags:covid-19"] });
  });
  it("dedupes case variants and tolerates missing arrays", () => {
    expect(membershipOf({ publishDate: "2026-01-31T23:30:00-08:00", ministryKeys: ["health", "HEALTH"] })).toEqual({ month: "2026-01", categories: ["ministries:health"] });
  });
  it("null for an unusable date", () => {
    expect(membershipOf({ ...post, publishDate: "garbage" })).toBeNull();
  });
});

describe("dependentPages (spec §6.2's post row)", () => {
  const m = (month: string, ...categories: string[]) => ({ month, categories });

  it("a new post: home, its categories, its month's archive and sitemap, the archive index and the sitemap index", () => {
    expect(dependentPages(null, m("2026-10", "ministries:health", "tags:covid-19"))).toEqual([
      "archive", "archive:2026-10", "category:ministries:health", "category:tags:covid-19", "home", "sitemap", "sitemap:2026-10",
    ]);
  });

  it("an unpublished post rebuilds the same pages from the stored row", () => {
    expect(dependentPages(m("2026-10", "ministries:health"), null)).toEqual(["archive", "archive:2026-10", "category:ministries:health", "home", "sitemap", "sitemap:2026-10"]);
  });

  it("a post that moves ministry and month rebuilds both old and new pages", () => {
    expect(dependentPages(m("2026-09", "ministries:health"), m("2026-10", "ministries:finance"))).toEqual([
      "archive", "archive:2026-09", "archive:2026-10", "category:ministries:finance", "category:ministries:health", "home", "sitemap", "sitemap:2026-09", "sitemap:2026-10",
    ]);
  });

  it("nothing before and nothing after: nothing", () => {
    expect(dependentPages(null, null)).toEqual([]);
  });

  it("never names the post page itself", () => {
    expect(dependentPages(null, m("2026-10")).some((id) => id.startsWith("post:"))).toBe(false);
  });
});
