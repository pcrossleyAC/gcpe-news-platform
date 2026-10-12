import { describe, expect, it } from "vitest";
import { renderPage, safeHref, safeSrc } from "./render";
import { expectAccessibleStructure } from "../test/structure";
import { DEFAULT_THEME } from "./theme-css";

describe("safeHref", () => {
  it("allows an absolute http or https URL", () => {
    expect(safeHref("https://gov.example/page")).toBe("https://gov.example/page");
    expect(safeHref("http://gov.example/page")).toBe("http://gov.example/page");
  });

  it("allows a mailto: URL", () => {
    expect(safeHref("mailto:alex@example.test")).toBe("mailto:alex@example.test");
  });

  it("allows a single-slash site-relative path", () => {
    expect(safeHref("/files/a.png")).toBe("/files/a.png");
    expect(safeHref("/releases/K1/")).toBe("/releases/K1/");
  });

  it("rejects a protocol-relative //host URL", () => {
    expect(safeHref("//evil.example/x")).toBeNull();
  });

  it("rejects javascript:, including case and whitespace tricks", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("\tjavascript:alert(1)\n")).toBeNull();
  });

  it("rejects data: and vbscript:", () => {
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects null, undefined, empty and malformed values", () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });

  // C209: a leading "/\host" "starts with / and not //", but every major
  // browser (and Node's own URL, same WHATWG algorithm) resolves a backslash the same as a
  // forward slash for http(s), so this used to land on a different origin entirely.
  it("rejects a backslash anywhere, including the /\\host bypass of the site-relative check", () => {
    expect(safeHref("/\\evil.example/phish")).toBeNull();
    expect(safeHref("\\/evil.example")).toBeNull();
    expect(safeHref("/files/a\\b.png")).toBeNull();
  });
});

describe("safeSrc", () => {
  it("allows http/https and a site-relative path, like safeHref", () => {
    expect(safeSrc("https://files.example/a.png")).toBe("https://files.example/a.png");
    expect(safeSrc("/files/a.png")).toBe("/files/a.png");
  });

  it("rejects mailto: (an image can't load it)", () => {
    expect(safeSrc("mailto:alex@example.test")).toBeNull();
  });

  it("rejects javascript: and //host, like safeHref", () => {
    expect(safeSrc("javascript:alert(1)")).toBeNull();
    expect(safeSrc("//evil.example/x")).toBeNull();
  });

  it("rejects a backslash anywhere, like safeHref", () => {
    expect(safeSrc("/\\evil.example/phish")).toBeNull();
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

  it("gates footer links through safeHref, rendering an unsafe scheme as plain text, defence in depth against a tenant config that bypassed the scheme check", () => {
    const hostile = { ...themed, theme: { ...themed.theme, footerLinks: [{ label: "Click me", url: "javascript:alert(1)" }] } };
    const html = renderPage("T", hostile, "/site/", "<h1>H</h1>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<li>Click me</li>");
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

  // Important #3: the config schema already restricts this to https:/relative, but render time
  // re-checks rather than trusting that a value reaching it was validated there — defence in
  // depth against the same class of bug the footer link check closed.
  it("drops the font stylesheet link when the URL isn't https: or site-relative, even if it slipped past config validation", () => {
    for (const bad of ["http://fonts.example/a.css", "javascript:alert(1)", "/\\evil.example/a.css"]) {
      const font = { ...themed, theme: { ...themed.theme, font: { ...themed.theme.font, stylesheetUrl: bad } } };
      const html = renderPage("T", font, "/site/", "<h1>H</h1>");
      expect(html).not.toContain('rel="stylesheet" href="' + bad);
      expect(html.match(/<link rel="stylesheet"/g)?.length).toBe(1); // only theme.css — no font link
    }
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
