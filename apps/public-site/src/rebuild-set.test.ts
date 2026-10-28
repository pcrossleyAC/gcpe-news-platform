import { describe, expect, it } from "vitest";
import { dependentPages, membershipOf } from "./rebuild-set";

const post = { publishDate: "2026-10-03T10:00:00-07:00", ministryKeys: ["Health"], sectorKeys: ["economy"], themeKeys: [], tagKeys: ["covid-19", "bad key"] };

describe("membershipOf", () => {
  it("takes the BC month from the offset date and lowercased, valid category tokens", () => {
    expect(membershipOf(post)).toEqual({ month: "2026-10", day: "2026-10-03", categories: ["ministries:health", "sectors:economy", "tags:covid-19"] });
  });
  it("dedupes case variants and tolerates missing arrays", () => {
    expect(membershipOf({ publishDate: "2026-01-31T23:30:00-08:00", ministryKeys: ["health", "HEALTH"] })).toEqual({ month: "2026-01", day: "2026-01-31", categories: ["ministries:health"] });
  });
  it("null for an unusable date", () => {
    expect(membershipOf({ ...post, publishDate: "garbage" })).toBeNull();
  });
});

describe("dependentPages (spec §6.2's post row)", () => {
  const m = (month: string, ...categories: string[]) => ({ month, day: `${month}-15`, categories });

  it("a new post: home, its categories, its month's archive and sitemap, the archive index and the sitemap index", () => {
    expect(dependentPages(null, m("2026-10", "ministries:health", "tags:covid-19"))).toEqual([
      "archive", "archive:2026-10", "category:ministries:health", "category:tags:covid-19", "home", "kind-feeds", "sitemap", "sitemap:2026-10",
    ]);
  });

  it("an unpublished post rebuilds the same pages from the stored row", () => {
    expect(dependentPages(m("2026-10", "ministries:health"), null)).toEqual(["archive", "archive:2026-10", "category:ministries:health", "home", "kind-feeds", "sitemap", "sitemap:2026-10"]);
  });

  it("a post that moves ministry and month rebuilds both old and new pages", () => {
    expect(dependentPages(m("2026-09", "ministries:health"), m("2026-10", "ministries:finance"))).toEqual([
      "archive", "archive:2026-09", "archive:2026-10", "category:ministries:finance", "category:ministries:health", "home", "kind-feeds", "sitemap", "sitemap:2026-09", "sitemap:2026-10",
    ]);
  });

  it("a post change re-queues kind-feeds", () => {
    expect(dependentPages(null, m("2026-10"))).toContain("kind-feeds");
    expect(dependentPages(m("2026-10"), null)).toContain("kind-feeds");
  });

  it("a factsheet post queues kind:factsheets; a post moving from stories to releases queues both", () => {
    expect(dependentPages(null, { ...m("2026-10"), kind: "factsheets" })).toContain("kind:factsheets");
    expect(dependentPages(null, { ...m("2026-10"), kind: "factsheets" })).not.toContain("kind:stories");
    const moved = dependentPages({ ...m("2026-10"), kind: "stories" }, { ...m("2026-10"), kind: "releases" });
    expect(moved).toEqual(expect.arrayContaining(["kind:stories", "kind:releases"]));
    expect(moved).not.toContain("kind:updates");
  });

  it("a kind with no listing (advisories) or an unknown kind queues no kind page", () => {
    expect(dependentPages(null, { ...m("2026-10"), kind: "advisories" }).some((id) => id.startsWith("kind:"))).toBe(false);
    expect(dependentPages(null, m("2026-10")).some((id) => id.startsWith("kind:"))).toBe(false);
  });

  it("nothing before and nothing after: nothing", () => {
    expect(dependentPages(null, null)).toEqual([]);
  });

  it("never names the post page itself", () => {
    expect(dependentPages(null, m("2026-10")).some((id) => id.startsWith("post:"))).toBe(false);
  });

  describe("with government terms", () => {
    // Terms: 2020-11-26 → 2024-11-17, then 2024-11-18 (current).
    const termOf = (day: string) => (day >= "2024-11-18" ? { slug: "2024-11-18", isCurrent: true } : day >= "2020-11-26" ? { slug: "2020-2024", isCurrent: false } : null);

    it("a post change queues its term page, the current alias and the terms index", () => {
      const ids = dependentPages(null, { month: "2024-12", day: "2024-12-01", categories: [] }, termOf);
      expect(ids).toEqual(expect.arrayContaining(["archive-term:2024-11-18", "archive-term:current", "archive-terms"]));
    });

    it("a post moved across a boundary rebuilds both terms' pages", () => {
      const ids = dependentPages({ month: "2024-11", day: "2024-11-17", categories: [] }, { month: "2024-11", day: "2024-11-18", categories: [] }, termOf);
      expect(ids.filter((id) => id.startsWith("archive-term"))).toEqual(["archive-term:2020-2024", "archive-term:2024-11-18", "archive-term:current", "archive-terms"]);
    });

    it("a past term's post doesn't touch the current alias; a day before every term only the index", () => {
      expect(dependentPages(null, { month: "2021-01", day: "2021-01-05", categories: [] }, termOf)).not.toContain("archive-term:current");
      expect(dependentPages(null, { month: "2001-01", day: "2001-01-05", categories: [] }, termOf).filter((id) => id.startsWith("archive-term"))).toEqual(["archive-terms"]);
    });
  });
});
