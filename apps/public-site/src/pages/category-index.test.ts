import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, post, site } from "../../test/fixtures";
import { renderCategoryIndex, type IndexGroup } from "./category-index";

const links = [{ key: "Contact us", uri: "/contacts/" }];
const g = (key: string, over: Partial<IndexGroup> = {}): IndexGroup => ({ key, name: key.toUpperCase(), top: null, feature: null, latest: [], ...over });
const render = (kind: Parameters<typeof renderCategoryIndex>[0], groups: IndexGroup[]) => expectAccessibleStructure(renderCategoryIndex(kind, groups, links, site, { settings: bcSettings() }));

describe("renderCategoryIndex", () => {
  const groups = [
    g("health", { name: "Health", top: post({ key: "T1" }), feature: post({ key: "F1" }), latest: [post({ key: "L1" })] }),
    g("finance", { name: "Finance" }),
  ];

  it("ministries: one h1 'News by Ministry' in div.news-listing > div.home-layout > div.home-body#main-content-release; a group per ministry with top, feature and first latest", () => {
    const doc = render("ministries", groups);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("h1")!.textContent).toBe("News by Ministry");
    expect(doc.querySelector("main .news-listing > .home-layout > .home-body#main-content-release > h1")).not.toBeNull();
    const [health] = doc.querySelectorAll(".grouped-articles");
    expect(health!.querySelector("h2 > a")!.getAttribute("href")).toBe("/ministries/health/");
    expect(health!.querySelector("h2 > a")!.textContent).toBe("Health");
    expect(health!.querySelector(":scope > .top-article a[href='/releases/T1/']")).not.toBeNull();
    expect(health!.querySelector(":scope > .other-articles > .feature-article a[href='/releases/F1/']")).not.toBeNull();
    expect(health!.querySelector(":scope > .other-articles > .regular-articles a[href='/releases/L1/']")).not.toBeNull();
    const more = health!.querySelector(".news-control a.load-more.link-button")!;
    expect(more.getAttribute("href")).toBe("/ministries/health/");
    expect(more.textContent).toBe("Browse More News");
    expect(health!.querySelector(".news-control a.read-more")!.getAttribute("href")).toBe("/search/?ministry=health");
    expect(health!.querySelector(".news-control a.read-more")!.textContent).toBe("Search News");
  });

  it("the Connect strip and the Resources box follow in section.home-features[aria-label='Connect and resources']", () => {
    const doc = render("tags", groups);
    const section = doc.querySelector("section.home-features")!;
    expect(section.getAttribute("aria-label")).toBe("Connect and resources");
    expect(section.querySelector("#connectAllSocialMedia")).not.toBeNull();
    expect(section.querySelector("a[href='/contacts/']")).not.toBeNull();
  });

  it("sectors: up to 3 latest as cards under div.other-articles > div.regular-articles, no top or feature; Search News uses ?sector=", () => {
    const latest = ["A", "B", "C", "D"].map((k) => post({ key: k }));
    const doc = render("sectors", [g("economy", { name: "Economy", top: post({ key: "T1" }), latest })]);
    const grp = doc.querySelector(".grouped-articles")!;
    expect(doc.querySelector("h1")!.textContent).toBe("News by Sector");
    expect(grp.querySelector(".top-article, .feature-article")).toBeNull();
    expect(grp.querySelectorAll(".other-articles > .regular-articles > .article")).toHaveLength(3);
    expect(grp.querySelector(".news-control a.read-more")!.getAttribute("href")).toBe("/search/?sector=economy");
  });

  it("themes and tags: no Search News; tags heading is 'News by Topic'; themes 'News by Theme'", () => {
    expect(render("themes", groups).querySelector("h1")!.textContent).toBe("News by Theme");
    const tags = render("tags", groups);
    expect(tags.querySelector("h1")!.textContent).toBe("News by Topic");
    expect(tags.querySelector(".news-control a.read-more")).toBeNull();
    expect(tags.querySelector(".news-control a.load-more")!.getAttribute("href")).toBe("/tags/health/");
  });

  it("a category with no posts still lists its heading and Browse More News", () => {
    const doc = render("tags", [g("empty", { name: "Empty" })]);
    const grp = doc.querySelector(".grouped-articles")!;
    expect(grp.querySelector("h2 > a")!.textContent).toBe("Empty");
    expect(grp.querySelector(".news-control a.load-more")!.textContent).toBe("Browse More News");
    expect(grp.querySelector(".article")).toBeNull();
  });

  it("escapes names and encodes keys in hrefs", () => {
    const html = renderCategoryIndex("sectors", [g("a-b", { name: `A & <B> "q"` })], links, site, { settings: bcSettings() });
    expect(html).toContain("A &amp; &lt;B&gt; &quot;q&quot;");
    expect(html).not.toContain("<B>");
    expect(html).toContain('href="/search/?sector=a-b"');
  });

  it("an empty list of categories still renders the heading and the strip", () => {
    const doc = render("themes", []);
    expect(doc.querySelectorAll(".grouped-articles")).toHaveLength(0);
    expect(doc.querySelector("section.home-features")).not.toBeNull();
  });
});
