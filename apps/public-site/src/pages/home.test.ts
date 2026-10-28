import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { SiteSettings } from "@gcpe/site-settings";
import { expectAccessibleStructure, withoutChromeScripts } from "../../test/structure";
import { bcSettings, link, post, site, slide } from "../../test/fixtures";
import { renderNotFoundPage } from "../static-pages";
import { renderCarousel, renderHomePage, type HomeView } from "./home";

const emptyView: HomeView = { top: null, feature: null, latest: [], slides: [], links: [], sectors: [] };
const subSite = { ...site, baseUrl: "https://boxs.example/site" };
const headline = (h: string) => [{ languageId: 4105, headline: h, subheadline: null, detailsHtml: null, contacts: [] }];
const latest = (n: number) => Array.from({ length: n }, (_, i) => post({ key: `L${i + 1}`, documents: headline(`Latest ${i + 1}`) }));
const parse = (html: string) => new JSDOM(html).window.document;

/** BC's settings with only the given networks holding an account. */
function withAccounts(...keys: (keyof SiteSettings["connect"])[]): SiteSettings {
  const s = bcSettings();
  for (const k of Object.keys(s.connect) as (keyof SiteSettings["connect"])[]) s.connect[k] = { featured: [], accounts: [] };
  for (const k of keys) s.connect[k] = { featured: [], accounts: [{ text: `@${k}`, url: `https://${k}.example/bc` }] };
  return s;
}

describe("home page", () => {
  it("exactly one h1 (visually hidden); .home-layout > .home-body + section.home-features[aria-label]; no <aside> inside main", () => {
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, top: post({ key: "T1" }), latest: latest(2), links: [link({})] }, site, {}));
    const h1 = doc.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toBe("Latest news");
    expect(h1[0]!.classList.contains("visually-hidden")).toBe(true);
    const layout = doc.querySelector("main > .home-layout")!;
    expect(layout).not.toBeNull();
    const children = [...layout.children];
    // The news first in the DOM, so phone reading and focus order match the visual order (the
    // column stacks below the news there); CSS order puts the column on the left on a desktop.
    expect(children.map((c) => `${c.tagName.toLowerCase()}.${c.className}`)).toEqual(["div.home-body", "section.home-features"]);
    expect(children[1]!.getAttribute("aria-label")).toBe("Connect and resources");
    expect(children[0]!.id).toBe("main-content-release");
    // Resources render once, inside the features column (legacy's JS clone, replaced by CSS order).
    expect(doc.querySelectorAll(".collapsible-regions")).toHaveLength(1);
    expect(doc.querySelector(".home-features > .collapsible-regions")).not.toBeNull();
    expect(doc.querySelector("main aside")).toBeNull();
  });

  it("top-article and feature-article hold one div.article each; regular-articles shows 3 and hides the rest with .hidden-article; Load More only when something is hidden", () => {
    const view = { ...emptyView, top: post({ key: "TOP1", documents: headline("Top headline") }), feature: post({ key: "FEAT1", documents: headline("Feature headline") }), latest: latest(5) };
    const doc = expectAccessibleStructure(renderHomePage(view, site, {}));
    const body = doc.querySelector(".home-body")!;
    expect(body.querySelectorAll(".top-article > div.article")).toHaveLength(1);
    expect(body.querySelector(".top-article .article h2 a")?.getAttribute("href")).toBe("/releases/TOP1/");
    expect(body.querySelector(".top-article .article h2 a")?.textContent).toBe("Top headline");
    expect(body.querySelectorAll(".other-articles > .feature-article > div.article")).toHaveLength(1);
    expect(body.querySelector(".feature-article h2 a")?.textContent).toBe("Feature headline");
    const regular = body.querySelector(".other-articles > div#regular-articles.regular-articles")!;
    const cards = [...regular.querySelectorAll(":scope > div.article")];
    expect(cards).toHaveLength(5);
    expect(cards.map((c) => c.classList.contains("hidden-article"))).toEqual([false, false, false, true, true]);
    expect(regular.querySelector(".item-date")).not.toBeNull();
    const control = body.querySelector(".other-articles > div.news-control")!;
    const more = control.querySelector("button.load-more.link-button")!;
    expect(more.getAttribute("type")).toBe("button");
    expect(more.getAttribute("aria-controls")).toBe("regular-articles");
    expect(more.textContent).toBe("Load More News");
    expect([...control.children].map((c) => c.tagName.toLowerCase() + "." + c.className)).toEqual(["button.load-more link-button", "a.read-more", "div.clear"]);
    expect(control.querySelector("a.read-more")?.getAttribute("href")).toBe("/search/");
    expect(control.querySelector("a.read-more")?.textContent).toBe("Search News");

    const three = parse(renderHomePage({ ...emptyView, latest: latest(3) }, site, {}));
    expect(three.querySelector(".hidden-article")).toBeNull();
    expect(three.querySelector(".load-more")).toBeNull();
    expect(three.querySelector(".news-control a.read-more")).not.toBeNull();
    // No top or feature post: neither wrapper renders.
    expect(three.querySelector(".top-article")).toBeNull();
    expect(three.querySelector(".feature-article")).toBeNull();
  });

  it("Connect With Us lists only networks with accounts, each img with alt and the base path; View all Social Media links /connect/", () => {
    const doc = expectAccessibleStructure(renderHomePage(emptyView, subSite, { settings: withAccounts("facebook", "bluesky", "youtube") }));
    const connect = doc.querySelector(".home-features > .resource-links.connect")!;
    expect(connect.querySelector("h2")?.textContent).toBe("Connect With Us");
    const lists = [...connect.querySelectorAll(":scope > ul")];
    expect(lists).toHaveLength(2);
    const items = (ul: Element) =>
      [...ul.querySelectorAll("li > a")].map((a) => {
        const img = a.querySelector("img")!;
        return [a.getAttribute("href"), img.getAttribute("src"), img.getAttribute("alt"), img.getAttribute("width"), img.getAttribute("height")];
      });
    expect(items(lists[0]!)).toEqual([
      ["/site/connect/#facebook", "/site/assets/legacy/Content/Images/SocialMedia/facebook-svg-logo.svg", "Facebook", "22", "22"],
      ["/site/connect/#bluesky", "/site/assets/legacy/Content/Images/SocialMedia/bluesky-logo.svg", "Bluesky", "22", "22"],
    ]);
    expect(items(lists[1]!)).toEqual([["/site/connect/#youtube", "/site/assets/legacy/Content/Images/SocialMedia/youtube.svg", "YouTube", "22", "22"]]);
    const all = connect.querySelector(":scope > a.read-more")!;
    expect(all.getAttribute("href")).toBe("/site/connect/");
    expect(all.textContent).toBe("View all Social Media");

    // Every network at BC's real settings: seven icons, in legacy order.
    const full = parse(renderHomePage(emptyView, site, { settings: bcSettings() }));
    expect([...full.querySelectorAll(".resource-links.connect img")].map((i) => i.getAttribute("alt"))).toEqual(["Facebook", "X", "Instagram", "Threads", "Bluesky", "Flickr", "YouTube"]);
    // A list with no network in it is left out.
    expect(parse(renderHomePage(emptyView, site, { settings: withAccounts("x") })).querySelectorAll(".resource-links.connect ul")).toHaveLength(1);
  });

  it("Resources and News by Sector (sector name + latest headline link); a sector with no post is left out", () => {
    const sectors = [
      { key: "economy", name: "Economy", latest: post({ key: "ECON1", documents: headline("Economy news") }) },
      { key: "empty", name: "Empty sector", latest: null },
      { key: "health", name: "Health & <care>", latest: post({ key: "HLTH1", documents: headline("Health news") }) },
    ];
    const links = [link({ uri: "https://gov.example/x", key: "Media Contacts" }), link({ uri: "javascript:alert(1)", key: "Evil resource" })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, sectors, links }, site, {}));
    const boxes = [...doc.querySelectorAll(".home-features > .collapsible-regions > div.resource-links")];
    expect(boxes.map((b) => b.querySelector("h2")?.textContent)).toEqual(["Resources", "News by Sector"]);
    const resources = boxes[0]!;
    expect(resources.querySelector("ul li a")?.getAttribute("href")).toBe("https://gov.example/x");
    expect(resources.querySelector("ul li a")?.textContent).toBe("Media Contacts");
    // An unsafe resource URL keeps its label, as text.
    expect(resources.querySelectorAll("ul li")[1]?.textContent).toBe("Evil resource");
    expect(resources.querySelectorAll("ul li a")).toHaveLength(1);
    const bySector = boxes[1]!.querySelector(":scope > div")!;
    expect([...bySector.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Economy", "Health & <care>"]);
    expect([...bySector.querySelectorAll("p > a")].map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["/releases/ECON1/", "Economy news"],
      ["/releases/HLTH1/", "Health news"],
    ]);
    expect(doc.body.textContent).not.toContain("Empty sector");

    // No links and no sector posts: neither box renders.
    const none = parse(renderHomePage({ ...emptyView, sectors: [{ key: "x", name: "X", latest: null }] }, site, {}));
    expect(none.querySelectorAll(".collapsible-regions .resource-links")).toHaveLength(0);
  });

  it("carousel goes in opts.lead: one .current, story.right for justify right, action label default 'Learn more', no buttons for one slide, empty for none; emergency slides are not in it", () => {
    const slides = [
      slide({ key: "S2", headline: "Second", sortIndex: 2, justify: "right", actionUri: "/archive/", actionLabel: null, imageUrl: "https://files.example/files/slides/b.png" }),
      slide({ key: "E1", headline: "Flood warning", emergency: true, sortIndex: 0 }),
      slide({ key: "S1", headline: "First", sortIndex: 1, actionUri: "https://gov.example/a", actionLabel: "See more" }),
    ];
    const html = renderHomePage({ ...emptyView, slides }, site, {});
    const doc = expectAccessibleStructure(html);
    // Between the header and #main-content (the page's lead band), not inside main.
    const holder = doc.querySelector("section#carousel-holder")!;
    expect(holder.previousElementSibling?.tagName).toBe("HEADER");
    expect(holder.nextElementSibling?.id).toBe("main-content");
    expect(holder.getAttribute("aria-label")).toBe("Highlights");
    expect(holder.getAttribute("aria-roledescription")).toBe("carousel");
    expect(holder.hasAttribute("aria-live")).toBe(false);
    const track = holder.querySelector(":scope > div.carousel-slides")!;
    expect(track.hasAttribute("aria-live")).toBe(false);
    const banners = [...track.querySelectorAll(":scope > div.home-banner")];
    // APG carousel: each slide a group with a position name.
    expect(banners.map((b) => [b.getAttribute("role"), b.getAttribute("aria-roledescription"), b.getAttribute("aria-label")])).toEqual([
      ["group", "slide", "Slide 1 of 2"],
      ["group", "slide", "Slide 2 of 2"],
    ]);
    expect(banners.map((b) => b.querySelector("h2")?.textContent)).toEqual(["First", "Second"]);
    expect(banners.map((b) => b.classList.contains("current"))).toEqual([true, false]);
    expect(holder.textContent).not.toContain("Flood warning");
    const story = (b: Element) => b.querySelector(":scope > .home-banner-content > .stories > .story")!;
    expect(story(banners[0]!).className).toBe("story left");
    expect(story(banners[1]!).className).toBe("story right");
    expect(story(banners[0]!).querySelector("h2 > a")?.getAttribute("href")).toBe("https://gov.example/a");
    expect(story(banners[0]!).querySelector("p.summary")?.textContent).toBe("New clinics are opening this month.");
    expect(story(banners[0]!).querySelector(":scope > div > a.read-more")?.textContent?.trim()).toBe("See more: First");
    // The visible label defaults to "Learn more"; the headline follows it, visually hidden.
    const learn = story(banners[1]!).querySelector(":scope > div > a.read-more")!;
    expect(learn.textContent?.trim()).toBe("Learn more: Second");
    expect(learn.querySelector("span.visually-hidden")?.textContent).toBe(": Second");

    expect(story(banners[1]!).querySelector("a.read-more svg.icon use")?.getAttribute("href")).toContain("#i-caret-right");
    const img = banners[1]!.querySelector(":scope > img.home-banner-image")!;
    expect(img.getAttribute("src")).toBe("https://files.example/files/slides/b.png");
    expect(img.getAttribute("alt")).toBe("");
    // Only the first slide's image is fetched eagerly (it is the page's largest paint).
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(banners[0]!.querySelector("img")).toBeNull();
    for (const b of banners) expect(b.lastElementChild?.className).toBe("bottom-fade");
    // Two slides: one Previous/Next pair, after the slides and outside their live region.
    expect(track.querySelector("button")).toBeNull();
    const controls = holder.querySelector(":scope > div.carousel-controls > .home-banner-content > .stories")!;
    const prev = controls.querySelector(":scope > button.story-nav.story-previous")!;
    const next = controls.querySelector(":scope > button.story-nav.story-next")!;
    expect(holder.querySelectorAll("button")).toHaveLength(2);
    expect(prev.getAttribute("type")).toBe("button");
    expect(prev.getAttribute("aria-label")).toBe("Previous highlight");
    expect(next.getAttribute("type")).toBe("button");
    expect(next.getAttribute("aria-label")).toBe("Next highlight");

    const one = parse(renderCarousel([slide({ key: "S1" })], ""));
    expect(one.querySelectorAll(".home-banner")).toHaveLength(1);
    expect(one.querySelector(".carousel-controls")).toBeNull();
    expect(one.querySelector(".home-banner.current")).not.toBeNull();
    expect(one.querySelector("button")).toBeNull();
    expect(renderCarousel([], "")).toBe("");
    expect(renderCarousel([slide({ emergency: true })], "")).toBe("");
    // No slides: no lead band at all.
    expect(parse(renderHomePage(emptyView, site, {})).getElementById("carousel-holder")).toBeNull();
  });

  it("an action link with no headline is named by its position, never a bare 'Learn more'", () => {
    const doc = parse(renderCarousel([slide({ key: "A" }), slide({ key: "B", headline: null, actionUri: "/archive/", actionLabel: null, sortIndex: 1 })], ""));
    const a = doc.querySelectorAll(".home-banner")[1]!.querySelector("a.read-more")!;
    expect(a.textContent?.trim()).toBe("Learn more: slide 2 of 2");
    expect(doc.querySelectorAll(".home-banner")[1]!.querySelector("h2")).toBeNull();
    const page = parse(renderHomePage({ ...emptyView, slides: [slide({ headline: null, emergency: true, actionUri: "/archive/", actionLabel: "Details" })] }, site, {}));
    expect(page.querySelector(".home-body .article a.read-more")?.textContent?.trim()).toBe("Details: emergency notice 1 of 1");
  });

  it("a slide with a javascript: action renders its headline as text, no link", () => {
    for (const actionUri of ["javascript:alert(1)", "/\\evil.example/phish"]) {
      const html = renderCarousel([slide({ headline: "Plain headline", actionUri, actionLabel: "Go" })], "");
      const doc = parse(html);
      expect(doc.querySelector(".story h2")?.textContent).toBe("Plain headline");
      expect(doc.querySelector(".story a")).toBeNull();
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("evil.example");
      expect(html).not.toContain(">Go<");
    }
    // An unsafe image URL renders no image.
    expect(parse(renderCarousel([slide({ imageUrl: "javascript:alert(1)" })], "")).querySelector("img")).toBeNull();
  });

  it("escapes slide text and resource labels", () => {
    const html = renderHomePage({ ...emptyView, slides: [slide({ headline: "<img src=x onerror=alert(1)>" })], links: [link({ key: 'Guide & <info>"' })] }, site, {});
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Guide &amp; &lt;info&gt;&quot;");
  });

  it("shows a labelled Emergency information region with its slides as div.article cards, first in .home-body", () => {
    const slides = [slide({ key: "E1", headline: "Flood warning", emergency: true, actionUri: "/archive/", actionLabel: null }), slide({ key: "H1", headline: "Highlight one" })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, top: post({ key: "T1" }), slides }, site, {}));
    const body = doc.querySelector(".home-body")!;
    const region = body.firstElementChild!;
    expect(region.tagName).toBe("SECTION");
    expect(doc.getElementById(region.getAttribute("aria-labelledby")!)?.textContent).toBe("Emergency information");
    const cards = region.querySelectorAll("div.article");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector("h3")?.textContent).toBe("Flood warning");
    expect(cards[0]!.querySelector("a.read-more")?.getAttribute("href")).toBe("/archive/");
    expect(cards[0]!.querySelector("a.read-more")?.textContent?.trim()).toBe("Learn more: Flood warning");
    expect(parse(renderHomePage({ ...emptyView, slides: [slides[1]!] }, site, {})).getElementById("emergency-heading")).toBeNull();
  });

  it("emits no <script> tag but the chrome's — the carousel doesn't rotate (C205)", () => {
    const full: HomeView = { ...emptyView, top: post({ key: "T1" }), feature: post({ key: "F1" }), latest: latest(5), slides: [slide({}), slide({ key: "S2" })], links: [link({})] };
    expect(withoutChromeScripts(renderHomePage(full, site, {}))).not.toContain("<script");
  });

  it("links the feed alternate at /feed.xml", () => {
    const html = renderHomePage(emptyView, site, {});
    expect(html).toContain('<link rel="alternate" type="application/rss+xml"');
    expect(html).toContain('href="/feed.xml"');
  });

  it("home <head> carries <meta name=\"google-site-verification\" content=\"…\"> only when set; other pages never", () => {
    const token = "ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss";
    const meta = (html: string) => parse(html).querySelector('meta[name="google-site-verification"]');
    expect(meta(renderHomePage(emptyView, { ...site, verification: { googleFile: null, googleMeta: token } }, {}))?.getAttribute("content")).toBe(token);
    expect(meta(renderHomePage(emptyView, site, {}))).toBeNull();
    expect(meta(renderHomePage(emptyView, { ...site, verification: { googleFile: null, googleMeta: null } }, {}))).toBeNull();
    // A value that slipped past env validation still can't reach the head.
    expect(meta(renderHomePage(emptyView, { ...site, verification: { googleFile: null, googleMeta: 'x"><script>' } }, {}))).toBeNull();
    // Other pages never carry it, even with the site's verification set.
    expect(renderNotFoundPage({ ...site, verification: { googleFile: null, googleMeta: token } }, {})).not.toContain("google-site-verification");
  });
});
