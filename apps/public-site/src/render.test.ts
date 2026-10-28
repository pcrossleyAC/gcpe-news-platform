import { describe, expect, it, vi } from "vitest";
import { renderPage, safeHref, safeSrc } from "./render";
import { expectAccessibleStructure } from "../test/structure";
import { DEFAULT_THEME } from "./theme-css";
import { SITE_BANNER_SCRIPT } from "./banner-script";
import { bcSettings } from "../test/fixtures";

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

  it("with no settings given, the footer's More Info list comes from the tenant theme's footerLinks (escaped)", () => {
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

describe("renderPage footer from site settings", () => {
  const site = { name: "BC Gov News", baseUrl: "https://boxs.example/site", theme: DEFAULT_THEME, timeZone: "America/Vancouver" };
  const settings = bcSettings();
  const footer = (html: string) => expectAccessibleStructure(html).querySelector("footer")!;

  it("the help sentence: help text, then the links with the comma rule", () => {
    const f = footer(renderPage("T", site, "/site/", "<h1>H</h1>", { settings }));
    expect(f.querySelector(".footer-help")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "We can help in over 220 languages and through other accessible options. Call, email or text us, or find a service centre.",
    );
    expect([...f.querySelectorAll(".footer-help a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://www2.gov.bc.ca/gov/content/home/get-help-with-government-services",
      "https://www2.gov.bc.ca/gov/content/home/services-a-z",
    ]);
  });

  it("the comma rule with three links and with one", () => {
    const three = { ...settings, footer: { ...settings.footer, helpText: "Help.", helpLinks: [{ text: "A", url: "/a" }, { text: "B", url: "/b" }, { text: "C", url: "/c" }] } };
    expect(footer(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: three })).querySelector(".footer-help")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Help. A, B, or C.");
    const one = { ...settings, footer: { ...settings.footer, helpText: "Help.", helpLinks: [{ text: "A", url: "/a" }] } };
    expect(footer(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: one })).querySelector(".footer-help")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Help. A.");
  });

  it("Connect with Us and More Info lists carry their ids; / links get the base path", () => {
    const f = footer(renderPage("T", site, "/site/", "<h1>H</h1>", { settings }));
    const lists = [...f.querySelectorAll("h2")].map((h) => h.textContent);
    expect(lists).toEqual(["Connect with Us", "More Info"]);
    const subscribe = f.querySelector("#footerNewsletters")!;
    expect(subscribe.textContent).toBe("Subscribe");
    expect(subscribe.getAttribute("href")).toBe("/site/subscribe");
    expect(f.querySelector("#footerRSSFeeds")?.getAttribute("href")).toBe("/site/connect");
    expect([...f.querySelectorAll(".footer-more-info a")].map((a) => a.id)).toEqual(["footerHome", "footerDisclaimer", "footerPrivacy", "footerAccessibility", "footerCopyright", "footerContact"]);
    expect(f.querySelector("#footerHome")?.getAttribute("href")).toBe("https://gov.bc.ca");
  });

  it("© {year} {holder}, the year in the tenant time zone", () => {
    vi.useFakeTimers({ now: new Date("2027-01-01T06:30:00Z"), toFake: ["Date"] }); // 2026-12-31 23:30 in Vancouver (UTC-7 year-round from 2026-11-01)
    try {
      expect(footer(renderPage("T", site, "/site/", "<h1>H</h1>", { settings })).querySelector(".copyright")?.textContent).toBe("© 2026 Government of British Columbia");
      expect(footer(renderPage("T", { ...site, timeZone: "UTC" }, "/site/", "<h1>H</h1>", { settings })).querySelector(".copyright")?.textContent).toBe("© 2027 Government of British Columbia");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unvalidated document: markup is escaped, a javascript: or http URL is text without a link, a hostile id is escaped", () => {
    const hostile = {
      ...settings,
      footer: {
        helpText: "<b>Help</b>",
        helpLinks: [{ text: "<i>Call</i>", url: "javascript:alert(1)" }],
        connectLinks: [{ text: "Sub", url: "/subscribe", id: 'x" onclick="alert(1)' }],
        moreInfoLinks: [{ text: "Insecure", url: "http://gov.bc.ca" }, { text: "Off-site", url: "//evil.example" }],
        copyrightHolder: "<script>alert(1)</script>",
      },
    };
    const html = renderPage("T", site, "/site/", "<h1>H</h1>", { settings: hostile });
    const f = footer(html);
    expect(f.querySelector("b, i, script")).toBeNull();
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain('href="http://gov.bc.ca"');
    expect(f.querySelector(".footer-help")?.textContent).toContain("<b>Help</b>");
    expect(f.querySelector(".footer-help a")).toBeNull();
    expect(f.querySelector(".footer-help")?.textContent).toContain("<i>Call</i>.");
    expect(f.querySelector(".footer-connect a")?.id).toBe('x" onclick="alert(1)');
    expect(f.querySelector(".footer-connect a")?.getAttribute("onclick")).toBeNull();
    expect([...f.querySelectorAll(".footer-more-info li")].map((li) => [li.textContent, li.querySelector("a")])).toEqual([["Insecure", null], ["Off-site", null]]);
    expect(f.querySelector(".copyright")?.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("renderPage site banner placeholder", () => {
  const site = { name: "BC Gov News", baseUrl: "https://boxs.example/site", theme: DEFAULT_THEME };

  it("every page has the hidden placeholder with the base path, and the inline script after it", () => {
    const html = renderPage("T", site, "/site/", "<h1>H</h1>", { settings: bcSettings() });
    expect(html).toContain('<div id="site-banner" hidden data-base="/site"></div>');
    expect(html).toContain(`<script>${SITE_BANNER_SCRIPT}</script>`);
    expect(html.indexOf('id="site-banner"')).toBeLessThan(html.indexOf(SITE_BANNER_SCRIPT));
    expectAccessibleStructure(html);
  });

  it("the placeholder follows the Blue Bridge banner, so the script can see it", () => {
    const html = renderPage("T", site, "/site/", "<h1>H</h1>", { banner: "Blue Bridge" });
    expect(html.indexOf("blue-bridge-banner")).toBeLessThan(html.indexOf('id="site-banner"'));
  });
});
