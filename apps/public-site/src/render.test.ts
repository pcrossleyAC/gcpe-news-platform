import { describe, expect, it } from "vitest";
import { renderHomePage, renderPage, renderPostPage, type PostDto } from "./render";
import { expectAccessibleStructure } from "../test/structure";
import { DEFAULT_THEME } from "./theme-css";

const post: PostDto = {
  key: "2026HLTH0001-000001", kind: "releases", publishDate: "2026-10-03T10:00:00-07:00", summary: "Summary <b>", location: "VICTORIA",
  ministryKeys: ["health"],
  documents: [
    { languageId: 3084, headline: "Titre", subheadline: null, detailsHtml: "<p>fr</p>", contacts: [] },
    { languageId: 4105, headline: "Clinics <script>alert(1)</script>", subheadline: null, detailsHtml: "<p>Clinics will open.</p>", contacts: [{ title: "Media", details: "Alex Example\n250-555-0100" }] },
  ],
};
const site = { name: "BC Gov News", baseUrl: "https://news.example" };

describe("render", () => {
  it("renders the English document, escaped headline, trusted body, contacts", () => {
    const html = renderPostPage(post, site);
    expect(html).toContain("<title>Clinics &lt;script&gt;alert(1)&lt;/script&gt; | BC Gov News</title>");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("<p>Clinics will open.</p>");
    expect(html).toContain("Alex Example<br>250-555-0100");
    expect(html).toContain('<link rel="canonical" href="https://news.example/releases/2026HLTH0001-000001">');
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
  it("percent-encodes the key in the canonical link, like the home links (fix round 1, item 5)", () => {
    const spaced: PostDto = { ...post, key: "2026HLTH0001-00000 1" };
    const html = renderPostPage(spaced, site);
    expect(html).toContain('<link rel="canonical" href="https://news.example/releases/2026HLTH0001-00000%201">');
  });
  it("home lists posts linking to their pages", () => {
    const html = renderHomePage([post], site);
    expect(html).toContain('href="/releases/2026HLTH0001-000001"');
    expect(html).toContain("Clinics &lt;script&gt;");
  });

  // Plan 3d task 4: a test site gets noindex on every page kind; production doesn't.
  it("a test site carries the noindex meta on both page kinds; production doesn't", () => {
    const testPost = renderPostPage(post, site, { test: true });
    const testHome = renderHomePage([post], site, { test: true });
    expect(testPost).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(testHome).toContain('<meta name="robots" content="noindex, nofollow">');

    const prodPost = renderPostPage(post, site);
    const prodHome = renderHomePage([post], site);
    expect(prodPost).not.toContain("noindex");
    expect(prodHome).not.toContain("noindex");
  });

  // Plan 3d task 4: the Project Blue Bridge banner renders at the top of <body>, HTML-escaped,
  // on both page kinds when set, and is absent when null.
  it("renders the Blue Bridge banner, escaped, at the top of <body> on both page kinds when set", () => {
    const banner = "ALERT: <script>alert(1)</script>";
    const postHtml = renderPostPage(post, site, { banner });
    const homeHtml = renderHomePage([post], site, { banner });
    for (const html of [postHtml, homeHtml]) {
      expect(html).toContain('<div class="blue-bridge-banner" role="alert">ALERT: &lt;script&gt;alert(1)&lt;/script&gt;</div>');
      expect(html).not.toContain("<script>alert(1)");
      expect(html.indexOf("blue-bridge-banner")).toBeLessThan(html.indexOf("<header"));
    }
  });

  it("omits the banner entirely when null (the default)", () => {
    expect(renderPostPage(post, site)).not.toContain("blue-bridge-banner");
    expect(renderHomePage([post], site, { banner: null })).not.toContain("blue-bridge-banner");
  });

  // boxs.ca: the site is served under /site (PUBLIC_SITE_URL=https://boxs.ca/site), so a bare
  // "/releases/<key>" link 404'd. Links carry the base URL's path; at a root base they don't change.
  it("links carry the base URL's path prefix, with or without a trailing slash", () => {
    for (const baseUrl of ["https://boxs.ca/site", "https://boxs.ca/site/"]) {
      const sub = { name: "BC Gov News", baseUrl };
      const home = renderHomePage([post], sub);
      expect(home).toContain('href="/site/releases/2026HLTH0001-000001"');
      expect(home).toContain('<a class="brand" href="/site/">');
      expect(home).toContain('<link rel="canonical" href="https://boxs.ca/site/">');
      const page = renderPostPage(post, sub);
      expect(page).toContain('<a class="brand" href="/site/">');
      expect(page).toContain('<link rel="canonical" href="https://boxs.ca/site/releases/2026HLTH0001-000001">');
    }
  });
  it("a root base URL keeps root links", () => {
    expect(renderHomePage([post], { name: "BC Gov News", baseUrl: "https://news.example/" })).toContain('<a class="brand" href="/">');
    expect(renderPostPage(post, site)).toContain('<a class="brand" href="/">');
  });
});

describe("renderPage chrome", () => {
  const themed = { name: "BC Gov News", baseUrl: "https://boxs.example/site", theme: { ...DEFAULT_THEME, footerLinks: [{ label: 'Privacy & "you"', url: "https://example.test/privacy?a=1&b=2" }] } };

  it("has the skip link, the four landmarks, one h1 and lang", () => {
    const html = renderPage("Title", themed, "/site/x/", "<h1>Heading</h1><p>x</p>");
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("a.skip-link")?.textContent).toBe("Skip to main content");
    expect(doc.querySelector("main")?.getAttribute("tabindex")).toBe("-1");
    expect(doc.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe("/site/assets/theme.css");
  });

  it("nav links carry the base path", () => {
    const doc = expectAccessibleStructure(renderPage("T", themed, "/site/", "<h1>H</h1>"));
    expect([...doc.querySelectorAll("nav a")].map((a) => a.getAttribute("href"))).toEqual(["/site/", "/site/ministries/", "/site/archive/", "/site/search/"]);
  });

  it("escapes footer labels and URLs", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>");
    expect(html).toContain('Privacy &amp; &quot;you&quot;');
    expect(html).toContain('href="https://example.test/privacy?a=1&amp;b=2"');
  });

  it("shows the logo when one is set, the wordmark otherwise", () => {
    const withLogo = expectAccessibleStructure(renderPage("T", { ...themed, logo: { src: "/site/assets/logo.svg", alt: "Example <Gov>" } }, "/site/", "<h1>H</h1>"));
    expect(withLogo.querySelector("header img")?.getAttribute("alt")).toBe("Example <Gov>");
    const without = expectAccessibleStructure(renderPage("T", themed, "/site/", "<h1>H</h1>"));
    expect(without.querySelector("header img")).toBeNull();
    expect(without.querySelector("header .wordmark")?.textContent).toBe("BC Gov News");
  });

  it("links the font stylesheet only when configured", () => {
    expect(renderPage("T", themed, "/site/", "<h1>H</h1>")).not.toContain("fonts.example");
    const font = { ...themed, theme: { ...themed.theme, font: { ...themed.theme.font, stylesheetUrl: "https://fonts.example/a.css" } } };
    expect(renderPage("T", font, "/site/", "<h1>H</h1>")).toContain('<link rel="stylesheet" href="https://fonts.example/a.css">');
  });

  it("adds the feed alternate link and description when given", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>", { feed: { href: "/site/feed.xml", title: "Latest <news>" }, description: "A & B" });
    expect(html).toContain('<link rel="alternate" type="application/rss+xml" title="Latest &lt;news&gt;" href="/site/feed.xml">');
    expect(html).toContain('<meta name="description" content="A &amp; B">');
  });

  it("keeps the test noindex and the banner, and the skip link stays first", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>", { test: true, banner: "TEST — ALERT" });
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    expect(doc.querySelector('[role="alert"]')?.textContent).toBe("TEST — ALERT");
  });
});
