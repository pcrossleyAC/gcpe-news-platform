import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { post } from "../../test/fixtures";
import { latestCards, postCard, VISIBLE_LATEST } from "./post-card";

const site = { baseUrl: "https://boxs.example/site" };
const POST = "/site/releases/2026HLTH0001-000001/";
const card = (html: string) => {
  const f = JSDOM.fragment(html);
  expect(f.children).toHaveLength(1);
  return f.firstElementChild!;
};
const FLICKR = "https://live.staticflickr.com/65535/53912345678_0a1b2c3d4e_b.jpg";

describe("postCard", () => {
  it("emits div.article > h2 > a, .item-date with time, .item-text p, a.read-more with a visually-hidden headline", () => {
    const el = card(postCard(site, post({ publishDate: "2026-09-22T11:45:00-07:00" })));
    expect(el.className).toBe("article");
    expect(el.querySelector(":scope > h2 > a")?.getAttribute("href")).toBe(POST);
    expect(el.querySelector(":scope > h2 > a")?.textContent).toBe("Clinics to open across the province");
    expect(el.querySelector(":scope > div.list-container.ps-0.pb-0 > div.item-date")?.textContent).toBe("Tuesday, September 22, 2026 11:45 AM");
    expect(el.querySelector(":scope > div.item-content > div.item-text")?.className).toBe("item-text");
    expect(el.querySelector(".item-text > p")?.textContent).toBe("Clinics are opening across the province this month.");
    const more = el.querySelector(".item-text > a.read-more")!;
    expect(more.getAttribute("href")).toBe(POST);
    expect(more.querySelector("svg use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-caret-right");
    expect(more.textContent).toBe(" Read More: Clinics to open across the province");
    expect(more.querySelector("span.visually-hidden")?.textContent).toBe(": Clinics to open across the province");
    expect(el.querySelector(":scope > div.clear")).not.toBeNull();
    expect([...el.children].map((c) => c.tagName.toLowerCase() + "." + c.className.replace(/ /g, "."))).toEqual(["h2.", "div.list-container.ps-0.pb-0", "div.item-content", "div.clear"]);
    expect(postCard(site, post())).not.toContain("<style");
  });

  it("media-assets and translations links only when the flags are true; absent flags render neither", () => {
    const none = card(postCard(site, post()));
    expect(none.querySelectorAll(".item-medialink")).toHaveLength(0);
    const falsy = card(postCard(site, post({ hasMediaAssets: false, hasTranslations: null })));
    expect(falsy.querySelectorAll(".item-medialink")).toHaveLength(0);
    const both = card(postCard(site, post({ hasMediaAssets: true, hasTranslations: true })));
    const assets = both.querySelector(".list-container > div.item-medialink.media-assets > a")!;
    expect(assets.getAttribute("href")).toBe(`${POST}#assets`);
    expect(assets.textContent).toBe(" Media Assets");
    expect(assets.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-download");
    const tr = both.querySelector(".list-container > div.item-medialink.translations > a")!;
    expect(tr.getAttribute("href")).toBe(`${POST}#translations`); // the body list, which phones show (C253)
    expect(tr.textContent).toBe(" Translations");
    expect(tr.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-language");
    const [first] = both.querySelectorAll(".list-container > div");
    expect(first?.className).toBe("item-date");
  });

  it("a Flickr assetUrl adds .item-asset img alt=''; a YouTube assetUrl adds no image", () => {
    const flickr = card(postCard(site, post({ assetUrl: FLICKR })));
    const asset = flickr.querySelector(".item-content > div.item-asset.asset.flickr")!;
    expect(asset.nextElementSibling?.className).toBe("item-text with-image");
    const a = asset.querySelector(":scope > a")!;
    expect(a.getAttribute("href")).toBe(POST);
    // Sized to the slot: the 320w `_n` by default, larger only when the layout needs it.
    const stem = "https://live.staticflickr.com/65535/53912345678_0a1b2c3d4e";
    expect(a.querySelector("img")?.getAttribute("src")).toBe(`${stem}_n.jpg`);
    expect(a.querySelector("img")?.getAttribute("srcset")).toBe(`${stem}_n.jpg 320w, ${stem}_z.jpg 640w, ${stem}_b.jpg 1024w`);
    expect(a.querySelector("img")?.getAttribute("sizes")).toBe("(max-width: 1120px) 100vw, 222px");
    expect([a.querySelector("img")?.getAttribute("width"), a.querySelector("img")?.getAttribute("height")]).toEqual(["320", "213"]);
    // Below the fold in a list: lazy. The top story's thumbnail (eager: true) may be the largest paint.
    expect(a.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(card(postCard(site, post({ assetUrl: FLICKR }), { eager: true })).querySelector(".item-asset img")?.hasAttribute("loading")).toBe(false);
    // A URL with no size suffix (the 500px default) gets the same set.
    const plain = card(postCard(site, post({ assetUrl: `${stem}.jpg` })));
    expect(plain.querySelector(".item-asset img")?.getAttribute("src")).toBe(`${stem}_n.jpg`);
    expect(a.querySelector("img")?.getAttribute("alt")).toBe("");
    // A duplicate of the headline link with a decorative image: kept out of the tab order and the
    // accessibility tree, so it is not a nameless link (axe link-name).
    expect(a.getAttribute("aria-hidden")).toBe("true");
    expect(a.getAttribute("tabindex")).toBe("-1");

    for (const url of ["https://www.youtube.com/watch?v=abcdef1", "https://youtu.be/abcdef1", "https://news.gov.bc.ca/live", "javascript:alert(1)", ""]) {
      const html = postCard(site, post({ assetUrl: url }));
      expect(html, url).not.toContain("<img");
      expect(html, url).not.toContain("youtube");
      expect(card(html).querySelector(".item-text")?.className, url).toBe("item-text");
    }
  });

  it("hidden: true adds .hidden-article", () => {
    expect(card(postCard(site, post(), { hidden: true })).className).toBe("article hidden-article");
    expect(card(postCard(site, post(), { hidden: false })).className).toBe("article");
  });

  it("escapes the headline and summary; falls back to the key; no summary means no paragraph", () => {
    const p = post({
      summary: "Tom & <b>Jerry</b>",
      documents: [{ languageId: 4105, headline: 'A "quoted" <i>headline</i>', subheadline: null, detailsHtml: null, contacts: [] }],
    });
    const html = postCard(site, p);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(card(html).querySelector("h2 a")?.textContent).toBe('A "quoted" <i>headline</i>');
    expect(card(html).querySelector(".item-text p")?.textContent).toBe("Tom & <b>Jerry</b>");

    const bare = card(postCard(site, post({ key: "K1", summary: null, documents: [] })));
    expect(bare.querySelector("h2 a")?.textContent).toBe("K1");
    expect(bare.querySelector(".item-text p")).toBeNull();
    expect(bare.querySelector(".read-more span.visually-hidden")?.textContent).toBe(": K1");
    expect(bare.outerHTML).not.toContain("undefined");
  });

  it("a multi-line summary is one paragraph per line, as legacy AsHtmlParagraphs", () => {
    const el = card(postCard(site, post({ summary: "One\nTwo" })));
    expect([...el.querySelectorAll(".item-text p")].map((p) => p.textContent)).toEqual(["One", "Two"]);
  });

  it("never yields a nameless link: every <a> has text, or is aria-hidden and out of the tab order", () => {
    const variants = [
      post(),
      post({ assetUrl: FLICKR, hasMediaAssets: true, hasTranslations: true }),
      post({ assetUrl: "https://youtu.be/abcdef1", summary: null }),
      post({ assetUrl: "https://news.gov.bc.ca/live", summary: "a\nb" }),
      post({ documents: [] }),
    ];
    for (const p of variants) {
      for (const eager of [false, true]) {
        const links = [...card(postCard(site, p, { eager })).querySelectorAll("a")];
        expect(links.length).toBeGreaterThan(0);
        for (const a of links) {
          const named = (a.textContent ?? "").trim() !== "" || (a.getAttribute("aria-label") ?? "").trim() !== "";
          const hidden = a.getAttribute("aria-hidden") === "true" && a.getAttribute("tabindex") === "-1";
          expect(named || hidden, a.outerHTML).toBe(true);
        }
      }
    }
  });

  it("latestCards: the first VISIBLE_LATEST cards shown, the rest .hidden-article, and Load More only when some are hidden", () => {
    expect(VISIBLE_LATEST).toBe(3);
    const posts = Array.from({ length: 5 }, (_, i) => post({ key: `K${i}` }));
    const many = latestCards(site, posts);
    const f = JSDOM.fragment(many.cards);
    expect([...f.querySelectorAll("div.article")].map((a) => a.classList.contains("hidden-article"))).toEqual([false, false, false, true, true]);
    expect(many.loadMore).toBe('<button type="button" class="load-more link-button" aria-controls="regular-articles">Load More News</button>\n');
    expect(latestCards(site, posts.slice(0, 3)).loadMore).toBe("");
    expect(latestCards(site, [])).toEqual({ cards: "", loadMore: "" });
  });
});

