import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { link, post, site, slide } from "../../test/fixtures";
import { renderHomePage, type HomeView } from "./home";

const emptyView: HomeView = { top: null, feature: null, latest: [], slides: [], links: [] };

describe("home page", () => {
  it("is accessible, with h1 'Latest news'", () => {
    const doc = expectAccessibleStructure(renderHomePage(emptyView, site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("Latest news");
  });

  it("shows the top and feature posts first, each under its own h2", () => {
    const top = post({ key: "TOP1", documents: [{ languageId: 4105, headline: "Top headline", subheadline: null, detailsHtml: null, contacts: [] }] });
    const feature = post({ key: "FEAT1", documents: [{ languageId: 4105, headline: "Feature headline", subheadline: null, detailsHtml: null, contacts: [] }] });
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, top, feature }, site, {}));
    const headings = [...doc.querySelectorAll("main h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Top story", "Featured"]);
    expect(doc.querySelector('a[href="/releases/TOP1/"]')?.textContent).toBe("Top headline");
    expect(doc.querySelector('a[href="/releases/FEAT1/"]')?.textContent).toBe("Feature headline");
  });

  it("renders latest posts as a post list linking to /releases/<key>/", () => {
    const latest = [post({ key: "L1" }), post({ key: "L2" })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, latest }, site, {}));
    const list = doc.querySelector("ul.post-list");
    expect(list).not.toBeNull();
    expect(list!.querySelector('a[href="/releases/L1/"]')).not.toBeNull();
    expect(list!.querySelector('a[href="/releases/L2/"]')).not.toBeNull();
  });

  it("renders slides as a labelled, non-rotating Highlights section with one article per slide", () => {
    const slides = [
      slide({ key: "S1", headline: "Slide one", summary: "Summary one", actionUri: "/archive/", actionLabel: "See more" }),
      slide({ key: "S2", actionUri: null, actionLabel: null }),
    ];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, slides }, site, {}));
    const section = doc.querySelector("section[aria-labelledby]");
    expect(section).not.toBeNull();
    const headingId = section!.getAttribute("aria-labelledby")!;
    expect(doc.getElementById(headingId)?.textContent).toBe("Highlights");
    const articles = section!.querySelectorAll("article");
    expect(articles).toHaveLength(2);
    expect(articles[0]!.querySelector("h3")?.textContent).toBe("Slide one");
    expect(articles[0]!.querySelector("a")?.getAttribute("href")).toBe("/archive/");
    expect(articles[0]!.querySelector("a")?.textContent).toBe("See more");
    expect(articles[1]!.querySelector("a")).toBeNull();
  });

  it("shows a labelled Emergency information region, with its pinned slides, before Highlights", () => {
    const slides = [slide({ key: "E1", headline: "Flood warning", emergency: true }), slide({ key: "H1", headline: "Highlight one", emergency: false })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, slides }, site, {}));
    const sections = [...doc.querySelectorAll("section[aria-labelledby]")];
    const headingTexts = sections.map((s) => doc.getElementById(s.getAttribute("aria-labelledby")!)?.textContent);
    expect(headingTexts).toEqual(["Emergency information", "Highlights"]);
    const emergencySection = sections[0]!;
    expect(emergencySection.querySelector("h3")?.textContent).toBe("Flood warning");
    expect(emergencySection.querySelectorAll("article")).toHaveLength(1);
  });

  it("shows no Emergency information region when no slide is pinned emergency", () => {
    const slides = [slide({ key: "H1", emergency: false })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, slides }, site, {}));
    expect(doc.getElementById("emergency-heading")).toBeNull();
  });

  it("renders a slide's image through safeSrc, decorative (alt=\"\")", () => {
    const slides = [slide({ key: "S1", imageUrl: "https://files.example/files/slides/abc.png" })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, slides }, site, {}));
    const img = doc.querySelector("article img");
    expect(img?.getAttribute("src")).toBe("https://files.example/files/slides/abc.png");
    expect(img?.getAttribute("alt")).toBe("");
  });

  it("renders no <img> for a slide without an imageUrl", () => {
    const slides = [slide({ key: "S1", imageUrl: null })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, slides }, site, {}));
    expect(doc.querySelector("article img")).toBeNull();
  });

  it("refuses an unsafe slide image URL (javascript:) instead of rendering an <img>", () => {
    const slides = [slide({ key: "S1", imageUrl: "javascript:alert(1)" })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, slides }, site, {}));
    expect(doc.querySelector("article img")).toBeNull();
  });

  it("defaults an action link's text to 'Learn more' when no actionLabel is given", () => {
    const slides = [slide({ actionUri: "/archive/", actionLabel: null })];
    const doc = expectAccessibleStructure(renderHomePage({ ...emptyView, slides }, site, {}));
    expect(doc.querySelector("article a")?.textContent).toBe("Learn more");
  });

  it("never emits a <script> tag anywhere on the page — the carousel doesn't rotate (C205)", () => {
    const full: HomeView = { top: post({ key: "T1" }), feature: post({ key: "F1" }), latest: [post({ key: "L1" })], slides: [slide({})], links: [link({})] };
    const html = renderHomePage(full, site, {});
    expect(html).not.toContain("<script");
  });

  it("escapes resource link labels", () => {
    const links = [link({ uri: "https://gov.example/x", key: 'Guide & <info>"' })];
    const html = renderHomePage({ ...emptyView, links }, site, {});
    expect(html).toContain("Guide &amp; &lt;info&gt;&quot;");
    expect(html).not.toContain("Guide & <info>");
  });

  it("escapes a slide headline that looks like markup", () => {
    const slides = [slide({ headline: "<img src=x onerror=alert(1)>" })];
    const html = renderHomePage({ ...emptyView, slides }, site, {});
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("refuses a javascript: slide action and resource-link URL instead of rendering a link", () => {
    const slides = [slide({ actionUri: "javascript:alert(1)", actionLabel: "Go" })];
    const links = [link({ uri: "javascript:alert(1)", key: "Evil resource" })];
    const html = renderHomePage({ ...emptyView, slides, links }, site, {});
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain(">Go<");
    expect(html).toContain("Evil resource"); // the label still shows, as plain text, not a link
    expect(html).not.toContain('<a href="javascript');
  });

  // C209: a leading "/\host" is browser-resolved the same as "//host" — a
  // different origin — even though it "starts with / and not //" under a naive relative check.
  it("refuses a /\\host slide action (the backslash-as-separator bypass), producing no link", () => {
    const slides = [slide({ actionUri: "/\\evil.example/phish", actionLabel: "Go" })];
    const html = renderHomePage({ ...emptyView, slides }, site, {});
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain(">Go<");
  });

  it("links the feed alternate at /feed.xml", () => {
    const html = renderHomePage(emptyView, site, {});
    expect(html).toContain('<link rel="alternate" type="application/rss+xml"');
    expect(html).toContain('href="/feed.xml"');
  });
});
