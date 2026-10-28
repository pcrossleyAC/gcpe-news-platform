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
    expect([...doc.querySelectorAll('link[rel="stylesheet"]')].at(-1)?.getAttribute("href")).toBe("/site/assets/theme.css");
  });

  it("the header's links carry the base path", () => {
    const doc = expectAccessibleStructure(renderPage("T", themed, "/site/", "<h1>H</h1>"));
    expect([...doc.querySelectorAll("header nav a")].map((a) => a.getAttribute("href"))).toEqual(["https://gov.bc.ca", "/site/", "/site/ministries/", "/site/subscribe/"]);
  });

  it("one skip link, one main#main inside div#main-content.template.container-xl, no h1 in the chrome", () => {
    const doc = expectAccessibleStructure(renderPage("T", themed, "/site/", "<h1>H</h1>", { ministryMenu: [{ key: "health", name: "Health" }] }));
    expect(doc.querySelectorAll("a.skip-link")).toHaveLength(1);
    expect(doc.querySelector("a.skip-link")?.getAttribute("href")).toBe("#main");
    expect(doc.querySelectorAll("main")).toHaveLength(1);
    const main = doc.querySelector("div#main-content.template.container-xl > main#main")!;
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(main.querySelector("h1")?.textContent).toBe("H");
    expect(doc.querySelector("header h1, footer h1")).toBeNull();
    expect(doc.querySelector("header")?.nextElementSibling?.id).toBe("main-content");
  });

  it("site.js is loaded deferred with the base path", () => {
    const at = (baseUrl: string) => expectAccessibleStructure(renderPage("T", { ...themed, baseUrl }, "/", "<h1>H</h1>")).querySelectorAll("script[src]");
    const scripts = at("https://boxs.example/site");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.getAttribute("src")).toBe("/site/assets/site/site.js");
    expect(scripts[0]!.hasAttribute("defer")).toBe(true);
    expect(at("https://boxs.example")[0]!.getAttribute("src")).toBe("/assets/site/site.js");
    // Review Focus 5: if site.js can't load, the html.js marker comes off so the no-JS fallbacks apply.
    expect(scripts[0]!.getAttribute("onerror")).toBe('document.documentElement.classList.remove("js")');
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>");
    expect(html.indexOf('src="/site/assets/site/site.js"')).toBeGreaterThan(html.indexOf("</footer>"));
    expect(html.indexOf('src="/site/assets/site/site.js"')).toBeLessThan(html.indexOf("</body>"));
  });

  it("with no settings given, the footer's More Info list comes from the tenant theme's footerLinks (escaped)", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>");
    expect(html).toContain('Privacy &amp; &quot;you&quot;');
    expect(html).toContain('href="https://example.test/privacy?a=1&amp;b=2"');
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
      expect(html).not.toContain(bad); // no font link
    }
  });

  it("adds the feed alternate link and description when given", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>", { feed: { href: "/site/feed.xml", title: "Latest <news>" }, description: "A & B" });
    expect(html).toContain('<link rel="alternate" type="application/rss+xml" title="Latest &lt;news&gt;" href="/site/feed.xml">');
    expect(html).toContain('<meta name="description" content="A &amp; B">');
  });

  const LEGACY_ORDER = [
    // One render-blocking request: bootstrap, site, custom, transforms, accessibility-styles (site-assets.ts).
    "/site/assets/legacy/Content/legacy.bundle.css",
    "/site/assets/legacy/Content/print.css",
    "/site/assets/site/overrides.css",
    "/site/assets/theme.css",
  ];
  const sheets = (html: string) => [...expectAccessibleStructure(html).querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href"));

  it("head links the legacy CSS (one bundle, then print), then overrides.css, then theme.css last", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>");
    expect(sheets(html)).toEqual(LEGACY_ORDER);
    const at = LEGACY_ORDER.map((href) => html.indexOf(`href="${href}"`));
    for (let i = 1; i < at.length; i++) expect(at[i]!).toBeGreaterThan(at[i - 1]!);
    expect(at[0]!).toBeGreaterThan(html.indexOf('<link rel="canonical"'));
    // The configured font link and the feed alternate still come after theme.css.
    const font = { ...themed, theme: { ...themed.theme, font: { ...themed.theme.font, stylesheetUrl: "https://fonts.example/a.css" } } };
    const withExtras = renderPage("T", font, "/site/", "<h1>H</h1>", { feed: { href: "/site/feed.xml", title: "F" } });
    expect(withExtras.indexOf("fonts.example/a.css")).toBeGreaterThan(withExtras.indexOf("/site/assets/theme.css"));
    expect(withExtras.indexOf('rel="alternate"')).toBeGreaterThan(withExtras.indexOf("fonts.example/a.css"));
  });

  it("print.css is media=print; granville-bridge-theme.css only with a Blue Bridge banner", () => {
    const doc = expectAccessibleStructure(renderPage("T", themed, "/site/", "<h1>H</h1>"));
    expect(doc.querySelector('link[href="/site/assets/legacy/Content/print.css"]')?.getAttribute("media")).toBe("print");
    expect(doc.querySelectorAll("link[media]")).toHaveLength(1);
    expect(doc.querySelector('link[href*="granville-bridge-theme.css"]')).toBeNull();
    expect(renderPage("T", themed, "/site/", "<h1>H</h1>", { banner: null })).not.toContain("granville-bridge-theme.css");
    const bridged = renderPage("T", themed, "/site/", "<h1>H</h1>", { banner: "Project Blue Bridge" });
    const order = [...expectAccessibleStructure(bridged).querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href"));
    expect(order).toEqual([...LEGACY_ORDER.slice(0, 2), "/site/assets/legacy/Content/granville-bridge-theme.css", ...LEGACY_ORDER.slice(2)]);
  });

  it("preloads BC Sans Regular (crossorigin, as the font fetch needs) before any stylesheet", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>");
    const preload = '<link rel="preload" href="/site/assets/legacy/fonts/BCSans-Regular.woff2" as="font" type="font/woff2" crossorigin>';
    expect(html).toContain(preload);
    expect(html.indexOf(preload)).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  it("favicon and the html.js marker script are in the head, before any stylesheet", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>");
    const head = html.slice(0, html.indexOf("</head>"));
    const icon = head.indexOf('<link rel="icon" href="/site/favicon.ico">');
    const js = head.indexOf('<script>document.documentElement.classList.add("js")</script>');
    expect(icon).toBeGreaterThan(head.indexOf('<link rel="canonical"'));
    expect(js).toBeGreaterThan(icon);
    expect(head.indexOf('rel="stylesheet"')).toBeGreaterThan(js);
    // At the root mount the base path is empty.
    expect(renderPage("T", { ...themed, baseUrl: "https://boxs.example" }, "/", "<h1>H</h1>")).toContain('<link rel="icon" href="/favicon.ico">');
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
    expect(f.querySelector(".footer-bc > p")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "We can help in over 220 languages and through other accessible options. Call, email or text us, or find a service centre.",
    );
    expect([...f.querySelectorAll(".footer-bc > p a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://www2.gov.bc.ca/gov/content/home/get-help-with-government-services",
      "https://www2.gov.bc.ca/gov/content/home/services-a-z",
    ]);
  });

  it("the comma rule with three links and with one", () => {
    const three = { ...settings, footer: { ...settings.footer, helpText: "Help.", helpLinks: [{ text: "A", url: "/a" }, { text: "B", url: "/b" }, { text: "C", url: "/c" }] } };
    expect(footer(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: three })).querySelector(".footer-bc > p")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Help. A, B, or C.");
    const one = { ...settings, footer: { ...settings.footer, helpText: "Help.", helpLinks: [{ text: "A", url: "/a" }] } };
    expect(footer(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: one })).querySelector(".footer-bc > p")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Help. A.");
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
    expect(f.querySelector(".footer-bc > p")?.textContent).toContain("<b>Help</b>");
    expect(f.querySelector(".footer-bc > p a")).toBeNull();
    expect(f.querySelector(".footer-bc > p")?.textContent).toContain("<i>Call</i>.");
    expect(f.querySelector(".footer-connect a")?.id).toBe('x" onclick="alert(1)');
    expect(f.querySelector(".footer-connect a")?.getAttribute("onclick")).toBeNull();
    expect([...f.querySelectorAll(".footer-more-info li")].map((li) => [li.textContent, li.querySelector("a")])).toEqual([["Insecure", null], ["Off-site", null]]);
    expect(f.querySelector(".copyright")?.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("renderPage footer skeleton and land acknowledgement band", () => {
  const site = { name: "BC Gov News", baseUrl: "https://boxs.example/site", theme: DEFAULT_THEME, timeZone: "America/Vancouver" };
  const withAck = (text: string | undefined) => {
    const s = bcSettings();
    if (text === undefined) delete s.footer.landAcknowledgement;
    else s.footer.landAcknowledgement = text;
    return s;
  };

  it("renders #landAcknowledgement with the settings text, escaped, above footer#footer", () => {
    const html = renderPage("T", site, "/site/", "<h1>H</h1>", { settings: withAck("We <b>acknowledge</b> & thank.") });
    const doc = expectAccessibleStructure(html);
    const band = doc.querySelector("aside#landAcknowledgement")!;
    expect(band).not.toBeNull();
    expect(band.className).toBe("container-fluid");
    expect(band.getAttribute("aria-label")).toBe("Land acknowledgement");
    expect(band.hasAttribute("style")).toBe(false);
    const p = band.querySelector(":scope > div.container-xl > p")!;
    expect(p.textContent).toBe("We <b>acknowledge</b> & thank.");
    expect(p.querySelector("b")).toBeNull();
    expect(p.hasAttribute("style")).toBe(false);
    expect(html).toContain("We &lt;b&gt;acknowledge&lt;/b&gt; &amp; thank.");
    expect(band.nextElementSibling).toBe(doc.querySelector("footer#footer"));
  });

  it("no band when the text is empty or whitespace", () => {
    for (const text of ["", "   \n\t "]) {
      const html = renderPage("T", site, "/site/", "<h1>H</h1>", { settings: withAck(text) });
      expect(html).not.toContain("landAcknowledgement");
      expect(expectAccessibleStructure(html).querySelector("aside")).toBeNull();
    }
    // A pre-field document that reached render unfilled is no band either, not "undefined".
    expect(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: withAck(undefined) })).not.toContain("landAcknowledgement");
  });

  it("footer#footer has .footer-bc (logo + help), nav[aria-label=Footer] with two h2 columns, hr, .bottom .copyright; no role=navigation or menu", () => {
    const html = renderPage("T", site, "/site/", "<h1>H</h1>", { settings: bcSettings() });
    const doc = expectAccessibleStructure(html);
    const f = doc.querySelector("footer")!;
    expect(f.id).toBe("footer");
    expect(f.className).toBe("container-fluid");
    const top = f.querySelector(":scope > div.top.container-xl")!;
    expect([...top.children].map((c) => c.tagName.toLowerCase() + (c.className ? "." + c.className : ""))).toEqual(["div.footer-bc", "nav", "hr"]);
    const logo = top.querySelector(".footer-bc > img#BCGov-logo-footer")!;
    expect(logo.getAttribute("src")).toBe("/site/assets/legacy/Content/Images/Gov/BCID_H_rgb_pos_LH_crop.svg");
    expect(logo.getAttribute("alt")).toBe("Government of B.C.");
    expect(top.querySelector(".footer-bc > p")?.textContent).toContain("We can help in over 220 languages");
    const nav = top.querySelector(":scope > nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Footer");
    expect([...nav.children].map((c) => c.className)).toEqual(["footer-connect", "footer-more-info"]);
    expect([...nav.querySelectorAll(":scope > div > h2")].map((h) => h.textContent)).toEqual(["Connect with Us", "More Info"]);
    expect(nav.querySelector(".footer-connect > ul")).not.toBeNull();
    expect(nav.querySelector(".footer-more-info > ul.pull-left")).not.toBeNull();
    expect(f.querySelector(":scope > div.container-xl.bottom > div.copyright")?.textContent).toMatch(/^© \d{4} Government of British Columbia$/);
    expect(f.querySelectorAll("h4")).toHaveLength(0);
    expect(doc.querySelectorAll('[role="navigation"], [role="menu"], [role="menuitem"]')).toHaveLength(0);
  });

  it("empty columns are omitted", () => {
    const s = bcSettings();
    s.footer.connectLinks = [];
    const nav = expectAccessibleStructure(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: s })).querySelector("footer nav")!;
    expect([...nav.children].map((c) => c.className)).toEqual(["footer-more-info"]);
    s.footer.moreInfoLinks = [];
    const doc = expectAccessibleStructure(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: s }));
    expect(doc.querySelector("footer nav")).toBeNull();
    expect(doc.querySelector("footer .top > hr")).not.toBeNull();
  });

  it("bridge footer logo when Blue Bridge is on", () => {
    const doc = expectAccessibleStructure(renderPage("T", site, "/site/", "<h1>H</h1>", { settings: bcSettings(), banner: "Blue Bridge" }));
    expect(doc.querySelector("#BCGov-logo-footer")?.getAttribute("src")).toBe("/site/assets/legacy/Content/Images/Gov/BCID_H_rgb_pos_LH_crop_bridge.svg");
    expect(doc.querySelectorAll("footer img")).toHaveLength(1);
  });
});

describe("renderPage site banner placeholder", () => {
  const site = { name: "BC Gov News", baseUrl: "https://boxs.example/site", theme: DEFAULT_THEME };

  it("every page has #banner (hidden while empty) right after the skip link, with the placeholder and the inline script inside", () => {
    const html = renderPage("T", site, "/site/", "<h1>H</h1>", { settings: bcSettings() });
    const placeholder = '<div id="site-banner" hidden data-base="/site" data-icons="/site/assets/site/icons.svg"></div>';
    expect(html).toContain(`<a class="skip-link" href="#main">Skip to main content</a>\n<section id="banner" aria-label="Site notices" hidden>\n${placeholder}\n<script>${SITE_BANNER_SCRIPT}</script>\n</section>`);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("#banner")?.tagName).toBe("SECTION");
    expect(doc.querySelector("#banner + header#main-nav")).not.toBeNull();
    expect(doc.querySelector('[role="alert"]')).toBeNull();
  });

  it("Blue Bridge: #banner > #bridge-banner.info-black-banner[role=alert] with a close button; granville CSS linked; bridge logos", () => {
    const html = renderPage("T", site, "/site/", "<h1>H</h1>", { banner: 'ALERT: <b>"x"</b>' });
    const doc = expectAccessibleStructure(html);
    const section = doc.querySelector("section#banner")!;
    expect(section.hasAttribute("hidden")).toBe(false);
    expect(section.getAttribute("aria-label")).toBe("Site notices");
    const bridge = section.firstElementChild!;
    expect(bridge.id).toBe("bridge-banner");
    expect(bridge.className).toBe("info-black-banner container-fluid sm-g-0");
    expect(bridge.getAttribute("role")).toBe("alert");
    expect(doc.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const content = bridge.querySelector(":scope > div.content.container-xl.sm-g-0")!;
    const [iconDiv, textDiv, closeDiv] = [...content.children];
    expect(content.childElementCount).toBe(3);
    expect(iconDiv!.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-circle-info");
    expect(textDiv!.textContent).toBe('ALERT: <b>"x"</b>');
    expect(textDiv!.querySelector("b")).toBeNull();
    const close = closeDiv!.querySelector(":scope > button")!;
    expect([close.id, close.getAttribute("type"), close.getAttribute("aria-label")]).toEqual(["btnCloseBannerBridge", "button", "Close banner"]);
    expect(close.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-xmark");
    // The site banner placeholder and script follow it, so the script sees it and stands down.
    expect(bridge.nextElementSibling?.id).toBe("site-banner");
    expect(doc.querySelector('link[href="/site/assets/legacy/Content/granville-bridge-theme.css"]')).not.toBeNull();
    expect([...doc.querySelectorAll("#BCGov-logo, #sm-BCGov-logo, #BCGov-logo-footer")].map((i) => i.getAttribute("src")!.replace(/^.*\//, ""))).toEqual([
      "BCID_H_rgb_pos_LH_crop_bridge.svg",
      "BC_Mark_bridge.svg",
      "BCID_H_rgb_pos_LH_crop_bridge.svg",
    ]);
  });

  it("no Blue Bridge: no #bridge-banner, no granville CSS, the standard logos", () => {
    const doc = expectAccessibleStructure(renderPage("T", site, "/site/", "<h1>H</h1>", { banner: null }));
    expect(doc.querySelector("#bridge-banner, .blue-bridge-banner")).toBeNull();
    expect(doc.querySelector('link[href*="granville"]')).toBeNull();
    expect(doc.querySelector("#BCGov-logo")?.getAttribute("src")).toMatch(/BCID_H_rgb_pos_LH_crop\.svg$/);
  });
});
