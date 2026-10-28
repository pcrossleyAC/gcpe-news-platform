import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, link, post, site } from "../../test/fixtures";
import { renderKindListing } from "./listing";

const title = "Factsheets & Opinion Editorials";
const posts = (n: number) => Array.from({ length: n }, (_, i) => post({ key: `F${i + 1}`, kind: "factsheets" }));

describe("renderKindListing", () => {
  it("one h1 with the settings title; 3 cards shown, the rest hidden, 'Load More Factsheets & Opinion Editorials' button; Search News → /search/?type=factsheets", () => {
    const doc = expectAccessibleStructure(renderKindListing("factsheets", title, posts(5), [], site, { settings: bcSettings() }));
    const h1 = doc.querySelector("h1")!;
    expect(h1.textContent).toBe(title);
    expect(h1.className).toBe("listing-title");
    const body = doc.querySelector("main > .home-layout > div.home-body#main-content-release")!;
    expect(body.querySelector("h1")).toBe(h1);
    const regular = body.querySelector(".other-articles > div#regular-articles.regular-articles")!;
    const cards = [...regular.querySelectorAll(":scope > div.article")];
    expect(cards.map((c) => c.classList.contains("hidden-article"))).toEqual([false, false, false, true, true]);
    const control = body.querySelector("div.news-control")!;
    expect(control.querySelector("button.load-more")!.textContent).toBe(`Load More ${title}`);
    const more = control.querySelector("a.read-more")!;
    expect(more.getAttribute("href")).toBe("/search/?type=factsheets");
    expect(more.textContent).toBe("Search News");
    expect(doc.querySelector(".listing-empty")).toBeNull();
  });

  it("factsheets listing links feeds/factsheets.xml as its alternate, titled '{title}: latest news'", () => {
    const doc = expectAccessibleStructure(renderKindListing("factsheets", title, posts(2), [], site, { settings: bcSettings() }));
    const alt = doc.querySelector('link[rel="alternate"][type="application/rss+xml"]')!;
    expect(alt.getAttribute("href")).toBe("/feeds/factsheets.xml");
    expect(alt.getAttribute("title")).toBe(`${title}: latest news`);
  });

  it("the feed alternate carries the base path, and an HTML-special title is escaped in its attribute", () => {
    const html = renderKindListing("stories", 'Tom & "Jerry" <b>', posts(1), [], { ...site, baseUrl: "https://news.example/site" }, { settings: bcSettings() });
    const alt = expectAccessibleStructure(html).querySelector('link[rel="alternate"][type="application/rss+xml"]')!;
    expect(alt.getAttribute("href")).toBe("/site/feeds/stories.xml");
    expect(alt.getAttribute("title")).toBe('Tom & "Jerry" <b>: latest news');
    expect(html).toContain('title="Tom &amp; &quot;Jerry&quot; &lt;b&gt;: latest news"');
    expect(html).toContain('href="/site/feeds/stories.xml"');
  });

  it("escapes the title", () => {
    const html = renderKindListing("stories", "A <b> & C", posts(4), [], site, { settings: bcSettings() });
    expect(html).toContain("A &lt;b&gt; &amp; C");
    expect(html).not.toContain("<b>");
  });

  it("strip and Resources in a labelled section after the body; no <aside>", () => {
    const doc = expectAccessibleStructure(renderKindListing("factsheets", title, posts(2), [link({})], site, { settings: bcSettings() }));
    const children = [...doc.querySelector("main > .home-layout")!.children];
    expect(children.map((c) => `${c.tagName.toLowerCase()}.${c.className}`)).toEqual(["div.home-body", "section.home-features"]);
    expect(children[1]!.getAttribute("aria-label")).toBe("Connect and resources");
    expect(children[1]!.querySelector(".connect-strip, .connect")).not.toBeNull();
    expect(children[1]!.querySelector(":scope > .collapsible-regions .resource-links")).not.toBeNull();
    expect(doc.querySelector("main aside")).toBeNull();
  });

  it("no links: no Resources box and no empty .collapsible-regions container", () => {
    const doc = expectAccessibleStructure(renderKindListing("stories", "Stories", posts(1), [], site, { settings: bcSettings() }));
    expect(doc.querySelector(".resource-links:not(.connect)")).toBeNull(); // the Connect strip is a .resource-links too
    expect(doc.querySelector(".collapsible-regions")).toBeNull();
  });

  it("no posts → empty message, no Load More", () => {
    const doc = expectAccessibleStructure(renderKindListing("updates", "Updates", [], [], site, { settings: bcSettings() }));
    expect(doc.querySelector("p.listing-empty")!.textContent).toBe("Nothing has been published yet.");
    expect(doc.querySelector("button.load-more")).toBeNull();
    expect(doc.querySelector("h1")!.textContent).toBe("Updates");
  });

  it("the page title is the listing title and the base path prefixes the search link", () => {
    const sub = { ...site, baseUrl: "https://boxs.example/site" };
    const html = renderKindListing("releases", "Releases", posts(1), [], sub, { settings: bcSettings() });
    expect(html).toContain("<title>Releases");
    expect(html).toContain('href="/site/search/?type=releases"');
  });
});
