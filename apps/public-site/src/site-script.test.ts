import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { MenuMinistry } from "./ministry-menu";
import { renderPage, type PageOptions } from "./render";
import { renderNotFoundPage } from "./static-pages";
import { SITE_BANNER_SCRIPT } from "./banner-script";
import { pathWords, SITE_SCRIPT } from "./site-script";
import { renderHomePage } from "./pages/home";
import { renderReleasePage } from "./pages/release";
import { renderLivePage } from "./pages/live";
import { bcSettings, post, slide } from "../test/fixtures";

const MENU: MenuMinistry[] = [
  { key: "office-of-the-premier", name: "Office of the Premier" },
  { key: "health", name: "Health" },
];
const site = { name: "BC Gov News", baseUrl: "https://boxs.example/site" };

/** A renderPage() document with SITE_SCRIPT run against it (the page's inline scripts are not run). */
function page(opts: PageOptions = { ministryMenu: MENU }, before?: (doc: Document) => void) {
  const dom = new JSDOM(renderPage("T", site, "/site/", "<h1>H</h1>", opts), { url: "https://boxs.example/site/", runScripts: "outside-only" });
  before?.(dom.window.document);
  dom.window.eval(SITE_SCRIPT);
  const doc = dom.window.document;
  const key = (k: string, target: Element = doc.activeElement ?? doc.body) =>
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  const iconOf = (el: Element) => el.querySelector("use")?.getAttribute("href")?.replace(/^.*#/, "");
  return { dom, doc, key, iconOf };
}

describe("site.js", () => {
  it("never contains </script>", () => {
    expect(SITE_SCRIPT).not.toMatch(/<\/script/i);
  });

  it("upgrades News to a button that opens #menu: aria-expanded true, .show, angle-up icon, body.menu-open", () => {
    const { doc, iconOf } = page();
    const news = doc.getElementById("news-dropdown")!;
    expect(news.tagName).toBe("BUTTON");
    expect(news.getAttribute("type")).toBe("button");
    expect(news.className).toBe("nav-link");
    expect(news.getAttribute("aria-expanded")).toBe("false");
    expect(news.getAttribute("aria-controls")).toBe("menu");
    expect(news.hasAttribute("href") || news.hasAttribute("data-menu")).toBe(false);
    expect(news.textContent).toBe("News");
    expect(iconOf(news)).toBe("i-angle-down");
    expect(news.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-angle-down");
    expect(doc.querySelectorAll("#news-dropdown")).toHaveLength(1);
    const menu = doc.getElementById("menu")!;
    news.click();
    expect(news.getAttribute("aria-expanded")).toBe("true");
    expect(menu.classList.contains("show")).toBe(true);
    expect(iconOf(news)).toBe("i-angle-up");
    expect(doc.body.classList.contains("menu-open")).toBe(true);
    news.click();
    expect(news.getAttribute("aria-expanded")).toBe("false");
    expect(menu.classList.contains("show")).toBe(false);
    expect(iconOf(news)).toBe("i-angle-down");
    expect(doc.body.classList.contains("menu-open")).toBe(false);
  });

  it("Escape closes the open panel and returns focus to its button", () => {
    const { doc, key, iconOf } = page();
    const news = doc.getElementById("news-dropdown")!;
    news.click();
    const link = doc.querySelector<HTMLAnchorElement>("#menu a")!;
    link.focus();
    key("Escape", link);
    expect(doc.getElementById("menu")!.classList.contains("show")).toBe(false);
    expect(news.getAttribute("aria-expanded")).toBe("false");
    expect(iconOf(news)).toBe("i-angle-down");
    expect(doc.body.classList.contains("menu-open")).toBe(false);
    expect(doc.activeElement).toBe(news);
    // The search drawer too; with nothing open, Escape changes nothing.
    const search = doc.getElementById("search-md-button")!;
    search.click();
    doc.getElementById("site-search-input")!.focus();
    key("Escape");
    expect(doc.getElementById("smd-search-container")!.classList.contains("show")).toBe(false);
    expect(doc.activeElement).toBe(search);
    key("Escape");
    expect(doc.activeElement).toBe(search);
  });

  it("the hamburger and search toggles open their targets and swap icons", () => {
    const { doc, iconOf } = page();
    for (const [id, target, closed] of [
      ["nav-menu-sm", "navbarSupportedContent", "i-bars"],
      ["search-md-button", "smd-search-container", "i-search"],
    ] as const) {
      const btn = doc.getElementById(id)!;
      const panel = doc.getElementById(target)!;
      expect(iconOf(btn)).toBe(closed);
      btn.click();
      expect(btn.getAttribute("aria-expanded"), id).toBe("true");
      expect(panel.classList.contains("show"), id).toBe(true);
      expect(iconOf(btn), id).toBe("i-xmark");
      expect(doc.body.classList.contains("menu-open"), id).toBe(false);
      btn.click();
      expect(btn.getAttribute("aria-expanded"), id).toBe("false");
      expect(panel.classList.contains("show"), id).toBe(false);
      expect(iconOf(btn), id).toBe(closed);
    }
  });

  it("opening one panel closes the other open one", () => {
    const { doc } = page();
    doc.getElementById("search-md-button")!.click();
    doc.getElementById("news-dropdown")!.click();
    expect(doc.getElementById("smd-search-container")!.classList.contains("show")).toBe(false);
    expect(doc.getElementById("search-md-button")!.getAttribute("aria-expanded")).toBe("false");
    expect(doc.getElementById("menu")!.classList.contains("show")).toBe(true);
  });

  it("phone: News inside the open drawer keeps the drawer open; Escape closes the menu first; closing the drawer closes the menu", () => {
    const { doc, key } = page();
    const burger = doc.getElementById("nav-menu-sm")!;
    const news = doc.getElementById("news-dropdown")!;
    const drawer = doc.getElementById("navbarSupportedContent")!;
    const menu = doc.getElementById("menu")!;
    burger.click();
    news.click();
    news.focus();
    expect([drawer.classList.contains("show"), menu.classList.contains("show")]).toEqual([true, true]);
    key("Escape");
    expect([drawer.classList.contains("show"), menu.classList.contains("show")]).toEqual([true, false]);
    expect(doc.activeElement).toBe(news);
    news.click();
    burger.click();
    expect([drawer.classList.contains("show"), menu.classList.contains("show")]).toEqual([false, false]);
    expect(news.getAttribute("aria-expanded")).toBe("false");
    expect(doc.body.classList.contains("menu-open")).toBe(false);
  });

  it("without #menu the News link stays a link", () => {
    for (const opts of [{ ministryMenu: null }, {}, { ministryMenu: [] }]) {
      const { doc } = page(opts);
      const news = doc.getElementById("news-dropdown")!;
      expect(news.tagName).toBe("A");
      expect(news.getAttribute("href")).toBe("/site/ministries/");
    }
  });

  it("Escape with focus outside the open panel and its button does nothing", () => {
    const { doc, key } = page();
    const news = doc.getElementById("news-dropdown")!;
    news.click();
    const h1 = doc.querySelector("h1")!;
    h1.setAttribute("tabindex", "-1");
    h1.focus();
    key("Escape", h1);
    expect(doc.getElementById("menu")!.classList.contains("show")).toBe(true);
    expect(doc.activeElement).toBe(h1);
    // On the toggle itself, it closes.
    news.focus();
    key("Escape", news);
    expect(doc.getElementById("menu")!.classList.contains("show")).toBe(false);
    expect(doc.activeElement).toBe(news);
  });

  it("on the search page the phone search control focuses (and scrolls to) the page's own box instead of opening a panel", () => {
    const { dom, doc } = page({ ministryMenu: MENU, pageSearchInput: "q" }, (d) => {
      d.getElementById("main")!.insertAdjacentHTML("beforeend", '<form role="search"><label for="q">Search for</label><input type="search" id="q" name="q"></form>');
    });
    const q = doc.getElementById("q") as HTMLInputElement;
    const scrolled: unknown[] = [];
    q.scrollIntoView = (arg?: unknown) => void scrolled.push(arg);
    const link = doc.getElementById("search-md-button")!;
    expect(link.tagName).toBe("A");
    const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(q);
    expect(scrolled).toEqual([{ block: "center" }]);
    expect(doc.querySelector(".show")).toBeNull();
    // The remaining toggles still work.
    doc.getElementById("news-dropdown")!.click();
    expect(doc.getElementById("menu")!.classList.contains("show")).toBe(true);
  });

  it("a page-search link whose target is missing is left to the browser (no throw, default not prevented)", () => {
    const { dom, doc } = page({ ministryMenu: MENU, pageSearchInput: "nope" });
    const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
    doc.getElementById("search-md-button")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("Escape closes a mouse-opened panel when focus stayed on the page (Safari, macOS Firefox: a click doesn't focus a button)", () => {
    const { doc, key } = page();
    const news = doc.getElementById("news-dropdown")!;
    news.click();
    (doc.activeElement as HTMLElement | null)?.blur();
    expect(doc.activeElement).toBe(doc.body);
    key("Escape", doc.body);
    expect(doc.getElementById("menu")!.classList.contains("show")).toBe(false);
    expect(news.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(news);
    // The phone drawer with News open in it: the innermost (the menu) first, then the drawer.
    const burger = doc.getElementById("nav-menu-sm")!;
    burger.click();
    news.click();
    (doc.activeElement as HTMLElement | null)?.blur();
    key("Escape", doc.body);
    expect([doc.getElementById("navbarSupportedContent")!.classList.contains("show"), doc.getElementById("menu")!.classList.contains("show")]).toEqual([true, false]);
    (doc.activeElement as HTMLElement | null)?.blur();
    key("Escape", doc.body);
    expect(doc.getElementById("navbarSupportedContent")!.classList.contains("show")).toBe(false);
    expect(doc.activeElement).toBe(burger);
  });

  describe("banner toggle", () => {
    const toggles = (doc: Document) => [doc.getElementById("bannerToggleLink")!, doc.getElementById("banner-toggle-sm")!];
    const state = (doc: Document) =>
      toggles(doc).map((b) => [b.parentElement!.hidden, b.getAttribute("aria-expanded")]);
    /** The site banner as banner-script.ts shows it: #banner and the placeholder unhidden, a close button, the event. */
    const showSiteBanner = (doc: Document) => {
      doc.getElementById("banner")!.hidden = false;
      const el = doc.getElementById("site-banner")!;
      el.hidden = false;
      const close = doc.createElement("button");
      close.id = "btnCloseBanner";
      close.type = "button";
      el.appendChild(close);
      doc.dispatchEvent(new doc.defaultView!.Event("site-banner-shown"));
      return close;
    };

    it("the toggle stays hidden when no banner was ever shown", () => {
      const { doc } = page();
      expect(state(doc)).toEqual([
        [true, "false"],
        [true, "false"],
      ]);
      expect(doc.getElementById("banner")!.hidden).toBe(true);
    });

    it("closing a banner reveals the header toggle; the toggle re-shows it and flips aria-expanded", () => {
      const { doc } = page();
      const banner = doc.getElementById("banner")!;
      const close = showSiteBanner(doc);
      // While a banner shows, the (i) shows too, expanded (news.gov always shows it).
      expect(state(doc)).toEqual([
        [false, "true"],
        [false, "true"],
      ]);
      close.click();
      expect(banner.hidden).toBe(true);
      expect(state(doc)).toEqual([
        [false, "false"],
        [false, "false"],
      ]);
      const [desktop, phone] = toggles(doc);
      desktop!.click();
      expect(banner.hidden).toBe(false);
      expect(doc.getElementById("site-banner")!.hidden).toBe(false);
      expect(state(doc).map(([, x]) => x)).toEqual(["true", "true"]);
      phone!.click();
      expect(banner.hidden).toBe(true);
      expect(state(doc).map(([, x]) => x)).toEqual(["false", "false"]);
      // The generic panel logic leaves #banner alone: no .show, and opening News doesn't hide it.
      phone!.click();
      doc.getElementById("news-dropdown")!.click();
      expect(banner.hidden).toBe(false);
      expect(banner.classList.contains("show")).toBe(false);
    });

    it("a banner shown before site.js ran (the fetch won the race) is picked up at start", () => {
      const { doc } = page({ ministryMenu: MENU }, (d) => {
        d.getElementById("banner")!.hidden = false;
        d.getElementById("site-banner")!.hidden = false;
      });
      expect(state(doc)).toEqual([
        [false, "true"],
        [false, "true"],
      ]);
    });

    it("Blue Bridge: the toggle shows at once; its close button hides #banner; the toggle brings it back", () => {
      const { doc } = page({ ministryMenu: MENU, banner: "Blue Bridge" });
      const banner = doc.getElementById("banner")!;
      expect(state(doc)).toEqual([
        [false, "true"],
        [false, "true"],
      ]);
      doc.getElementById("btnCloseBannerBridge")!.click();
      expect(banner.hidden).toBe(true);
      expect(state(doc).map(([, x]) => x)).toEqual(["false", "false"]);
      toggles(doc)[0]!.click();
      expect(banner.hidden).toBe(false);
      expect(doc.getElementById("bridge-banner")).not.toBeNull();
    });

    /** jsdom lays nothing out (offsetParent is always null): mark which toggle the CSS shows. */
    const showOnly = (doc: Document, which: 0 | 1) =>
      Object.defineProperty(toggles(doc)[which]!, "offsetParent", { get: () => doc.body, configurable: true });

    it("closing a banner moves focus to the visible (i) toggle, not to <body>", () => {
      for (const which of [0, 1] as const) {
        const { doc } = page();
        showOnly(doc, which);
        const close = showSiteBanner(doc);
        close.focus();
        close.click();
        expect(doc.activeElement).toBe(toggles(doc)[which]);
      }
      const bb = page({ ministryMenu: MENU, banner: "Blue Bridge" });
      showOnly(bb.doc, 0);
      const closeBridge = bb.doc.getElementById("btnCloseBannerBridge")!;
      closeBridge.focus();
      closeBridge.click();
      expect(bb.doc.activeElement).toBe(toggles(bb.doc)[0]);
    });

    it("a site banner closed before site.js ran still gets its (i) toggle, collapsed", () => {
      const { doc } = page({ ministryMenu: MENU }, (d) => {
        // banner-script.ts showed it, then its own close button hid #banner before site.js ran.
        const el = d.getElementById("site-banner")!;
        el.hidden = false;
        el.appendChild(d.createElement("div"));
        d.getElementById("banner")!.hidden = true;
      });
      expect(state(doc)).toEqual([
        [false, "false"],
        [false, "false"],
      ]);
      toggles(doc)[0]!.click();
      expect(doc.getElementById("banner")!.hidden).toBe(false);
    });

    it("the real banner script and site.js together: fetch, show, close through both listeners, re-show", async () => {
      const html = renderPage("T", site, "/site/", "<h1>H</h1>", { ministryMenu: MENU });
      const dom = new JSDOM(html, { url: "https://boxs.example/site/", runScripts: "outside-only" });
      const doc = dom.window.document;
      const json = { visible: true, style: "info", message: "Offices closed", links: [], dismissible: true };
      dom.window.fetch = (async () => new Response(JSON.stringify(json), { status: 200 })) as unknown as typeof fetch;
      // Page order: the inline banner script, then the deferred site.js.
      dom.window.eval(SITE_BANNER_SCRIPT);
      dom.window.eval(SITE_SCRIPT);
      showOnly(doc, 0);
      await new Promise((r) => setTimeout(r, 10));
      const banner = doc.getElementById("banner")!;
      expect(banner.hidden).toBe(false);
      expect(doc.getElementById("site-banner")!.textContent).toContain("Offices closed");
      expect(state(doc)).toEqual([
        [false, "true"],
        [false, "true"],
      ]);
      const close = doc.getElementById("btnCloseBanner")!;
      close.focus();
      close.click();
      expect(banner.hidden).toBe(true);
      expect(state(doc).map(([, x]) => x)).toEqual(["false", "false"]);
      expect(doc.activeElement).toBe(toggles(doc)[0]);
      toggles(doc)[0]!.click();
      expect(banner.hidden).toBe(false);
      expect(state(doc).map(([, x]) => x)).toEqual(["true", "true"]);
    });

    it("dismissal is not persisted", () => {
      const first = page({ ministryMenu: MENU, banner: "Blue Bridge" });
      first.doc.getElementById("btnCloseBannerBridge")!.click();
      const again = page({ ministryMenu: MENU, banner: "Blue Bridge" });
      expect(again.doc.getElementById("banner")!.hidden).toBe(false);
      expect(SITE_SCRIPT).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    });
  });

  // The brief's title says '2026hlth0085 housing plan', but its algorithm (and its step 5, "releases no such housing plan") keeps the leading segment.
  it("pathWords('/releases/2026hlth0085-housing-plan/', '') keeps every segment: 'releases 2026hlth0085 housing plan'", () => {
    expect(pathWords("/releases/2026hlth0085-housing-plan/", "")).toBe("releases 2026hlth0085 housing plan");
  });
  it("pathWords strips the base path and file extensions: ('/site/ministries/Health.aspx', '/site') is 'ministries Health'", () => {
    expect(pathWords("/site/ministries/Health.aspx", "/site")).toBe("ministries Health");
    expect(pathWords("/site/index.html", "/site")).toBe("");
    expect(pathWords("/a%20b/c_d+e", "")).toBe("a b c d e");
  });
  it("pathWords survives malformed percent-encoding and caps at 100 chars", () => {
    expect(pathWords("/50%-off/%E0%A4%A", "")).toBe("50% off %E0%A4%A");
    // Capped on a word boundary: twenty whole "word"s (99 chars), never a cut-off "wo".
    expect(pathWords("/" + "word-".repeat(60), "")).toBe(Array(20).fill("word").join(" "));
  });
  it("pathWords strips the base only on a segment boundary: '/sitemap-old' under '/site' keeps 'sitemap'", () => {
    expect(pathWords("/sitemap-old", "/site")).toBe("sitemap old");
    expect(pathWords("/site", "/site")).toBe("");
    expect(pathWords("/site/x", "/site")).toBe("x");
  });
  it("pathWords never leaves a lone surrogate: an over-long single word is cut on a code point", () => {
    const emoji = "\u{1F600}"; // two UTF-16 units
    const out = pathWords("/" + "a" + emoji.repeat(80), "");
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.length).toBe(99); // "a" + 49 emoji; a 50th would need units 100-101
    expect(out).toBe("a" + emoji.repeat(49));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
    // A short word after a long one isn't dropped mid-way: words are kept whole or not at all.
    expect(pathWords("/" + "x".repeat(95) + "-abcdef", "")).toBe("x".repeat(95));
  });
  it("site.js fills #not-found-q from location.pathname on a 404 page; leaves other pages' inputs alone", () => {
    const html = renderNotFoundPage(site, {});
    const run = (url: string, prep?: (d: Document) => void) => {
      const dom = new JSDOM(html, { url, runScripts: "outside-only" });
      prep?.(dom.window.document);
      dom.window.eval(SITE_SCRIPT);
      return dom.window.document.getElementById("not-found-q") as HTMLInputElement;
    };
    expect(run("https://boxs.example/site/releases/no-such-housing-plan/").value).toBe("releases no such housing plan");
    expect(run("https://boxs.example/site/releases/x/", (d) => ((d.getElementById("not-found-q") as HTMLInputElement).value = "typed")).value).toBe("typed");
    // Markup in the path lands as inert value text: no element is created from it.
    const xss = run("https://boxs.example/site/<img src=x onerror=alert(1)>");
    expect(xss.value).toBe("<img src=x onerror=alert(1)>");
    expect(xss.ownerDocument.querySelector("img[src='x'], img[onerror]")).toBeNull();
    // A form without the marker, or any other page's input, is untouched.
    const { doc } = page({ ministryMenu: MENU }, (d) => {
      d.querySelector("main")!.insertAdjacentHTML("beforeend", '<form><input id="not-found-q"></form>');
    });
    expect((doc.getElementById("not-found-q") as HTMLInputElement).value).toBe("");
    expect(doc.querySelectorAll("[data-prefill-from-path]")).toHaveLength(0);
  });
  it("Next/Previous move .current and wrap; Load More reveals hidden cards, removes itself, focuses the first revealed link", () => {
    const slides = ["A", "B", "C"].map((h, i) => slide({ key: `S${i}`, headline: h, sortIndex: i }));
    const latest = Array.from({ length: 5 }, (_, i) => post({ key: `L${i + 1}`, documents: [{ languageId: 4105, headline: `Latest ${i + 1}`, subheadline: null, detailsHtml: null, contacts: [] }] }));
    const html = renderHomePage({ top: null, feature: null, latest, slides, links: [], sectors: [] }, site, { ministryMenu: MENU });
    const dom = new JSDOM(html, { url: "https://boxs.example/site/", runScripts: "outside-only" });
    dom.window.eval(SITE_SCRIPT);
    const doc = dom.window.document;
    const holder = doc.getElementById("carousel-holder")!;
    const track = holder.querySelector(".carousel-slides")!;
    const current = () => [...track.querySelectorAll(".home-banner")].findIndex((b) => b.classList.contains("current"));
    const button = (cls: string) => holder.querySelector<HTMLButtonElement>(`.carousel-controls .${cls}`)!;
    expect(current()).toBe(0);
    expect(track.hasAttribute("aria-live")).toBe(false);
    button("story-next").focus();
    button("story-next").click();
    expect(current()).toBe(1);
    expect(track.querySelectorAll(".home-banner.current")).toHaveLength(1);
    // Only the slides are live, not the buttons (or the holder holding both).
    expect(track.getAttribute("aria-live")).toBe("polite");
    expect(holder.hasAttribute("aria-live")).toBe(false);
    // The buttons sit outside the slides, so focus stays on the one pressed.
    expect(doc.activeElement).toBe(button("story-next"));
    button("story-next").click();
    button("story-next").click();
    expect(current()).toBe(0);
    button("story-previous").click();
    expect(current()).toBe(2);
    button("story-previous").click();
    expect(current()).toBe(1);

    const regular = doc.getElementById("regular-articles")!;
    const hidden = [...regular.querySelectorAll(".hidden-article")];
    expect(hidden).toHaveLength(2);
    doc.querySelector<HTMLButtonElement>("button.load-more")!.click();
    expect(regular.querySelectorAll(".hidden-article")).toHaveLength(0);
    expect(doc.querySelector(".load-more")).toBeNull();
    expect(doc.activeElement).toBe(hidden[0]!.querySelector("h2 a"));
    expect(doc.activeElement?.textContent).toBe("Latest 4");
    // The Search News link stays.
    expect(doc.querySelector(".news-control a.read-more")).not.toBeNull();
  });

  it("Print calls window.print; the language buttons toggle body.lang-secondary and the French headline's heading role, never html[lang]", () => {
    const html = renderReleasePage(post(), site, { ministryMenu: MENU }, { related: [], leadMinistry: null, ministryLatest: [] });
    const dom = new JSDOM(html, { url: "https://boxs.example/site/releases/2026HLTH0001-000001/", runScripts: "outside-only" });
    let printed = 0;
    dom.window.print = () => void printed++;
    dom.window.eval(SITE_SCRIPT);
    const doc = dom.window.document;
    doc.querySelector<HTMLButtonElement>("button.print-document")!.click();
    expect(printed).toBe(1);

    const toFrench = doc.querySelector<HTMLButtonElement>('button[data-story-lang="secondary"]')!;
    const toEnglish = doc.querySelector<HTMLButtonElement>('button[data-story-lang="primary"]')!;
    expect(doc.body.classList.contains("lang-secondary")).toBe(false);
    const frHeadline = doc.querySelector(".story-headline")!;
    expect(frHeadline.hasAttribute("role")).toBe(false);
    toFrench.focus();
    toFrench.click();
    expect(doc.body.classList.contains("lang-secondary")).toBe(true);
    // P2-R3: <html lang> stays "en"; the French content carries its own lang="fr".
    expect(doc.documentElement.lang).toBe("en");
    // While French shows (the h1 is hidden) the French headline is the level-1 heading.
    expect([frHeadline.getAttribute("role"), frHeadline.getAttribute("aria-level")]).toEqual(["heading", "1"]);
    // The pressed button's line is now hidden: focus moves to the way back.
    expect(doc.activeElement).toBe(toEnglish);
    toEnglish.click();
    expect(doc.body.classList.contains("lang-secondary")).toBe(false);
    expect(doc.documentElement.lang).toBe("en");
    expect(frHeadline.hasAttribute("role") || frHeadline.hasAttribute("aria-level")).toBe(false);
    expect(doc.activeElement).toBe(toFrench);
  });
});

describe("site.js live webcast button", () => {
  /** A page with SITE_SCRIPT run, `fetch` answered by `answer` and setInterval captured (not run). */
  function livePage(answer: () => Promise<Response>, body = "<h1>H</h1>") {
    const dom = new JSDOM(renderPage("T", site, "/site/", body, { ministryMenu: MENU }), { url: "https://boxs.example/site/", runScripts: "outside-only" });
    const fetchMock = vi.fn(answer);
    const timers: { fn: () => void; ms: number }[] = [];
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    dom.window.setInterval = ((fn: () => void, ms: number) => timers.push({ fn, ms })) as unknown as typeof setInterval;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    dom.window.eval(SITE_SCRIPT);
    return { dom, doc: dom.window.document, fetchMock, timers, errors, button: dom.window.document.getElementById("live-button") };
  }
  const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("live.json {live:true} shows #live-button; {live:false}, a 404 and a network error leave it hidden; it polls every 60 s", async () => {
    const on = livePage(json({ live: true }));
    expect(on.fetchMock).toHaveBeenCalledWith("/site/assets/live.json", { cache: "no-store" });
    await settle();
    expect(on.button!.classList.contains("live_button_show")).toBe(true);
    expect(on.button!.classList.contains("live_button_hide")).toBe(false);
    expect(on.timers.map((t) => t.ms)).toEqual([60000]);
    // The next poll hides it again when the stream has ended.
    on.fetchMock.mockImplementation(json({ live: false }));
    on.timers[0]!.fn();
    await settle();
    expect(on.fetchMock).toHaveBeenCalledTimes(2);
    expect(on.button!.classList.contains("live_button_hide")).toBe(true);
    expect(on.button!.classList.contains("live_button_show")).toBe(false);

    for (const answer of [json({ live: false }), json({}, 404), json({ live: "true" }), async () => { throw new Error("offline"); }, async () => new Response("not json")]) {
      const p = livePage(answer);
      await settle();
      expect(p.button!.classList.contains("live_button_hide")).toBe(true);
      expect(p.button!.classList.contains("live_button_show")).toBe(false);
      expect(p.errors).not.toHaveBeenCalled(); // errors are swallowed silently
    }
  });

  it("does not poll on a page without #live-button", async () => {
    const dom = new JSDOM("<!doctype html><body><h1>x</h1></body>", { url: "https://boxs.example/site/", runScripts: "outside-only" });
    const fetchMock = vi.fn();
    const setIntervalMock = vi.fn();
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    dom.window.setInterval = setIntervalMock as unknown as typeof setInterval;
    dom.window.eval(SITE_SCRIPT);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setIntervalMock).not.toHaveBeenCalled();
  });

  it("the News button keeps the settings label", () => {
    const dom = new JSDOM(renderPage("T", site, "/site/", "<h1>H</h1>", { ministryMenu: MENU, settings: { ...bcSettings(), navigation: { ...bcSettings().navigation, newsLabel: "Newsroom" } } }), { url: "https://boxs.example/site/", runScripts: "outside-only" });
    dom.window.eval(SITE_SCRIPT);
    expect(dom.window.document.getElementById("news-dropdown")!.textContent).toBe("Newsroom");
  });
});

describe("site.js live webcast player (/live/)", () => {
  const STREAM = "https://stream.example.gov.bc.ca/live/playlist.m3u8";
  const ERROR_TEXT = "The webcast can't play here. Use the stream link below.";
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /** The /live/ page with SITE_SCRIPT run; `native` is what video.canPlayType answers. fetch and
   * every setter that would contact the stream host are recorded. */
  function livePlayer(native: "" | "maybe" | "probably", opts: { play?: () => Promise<void> | void } = {}) {
    const dom = new JSDOM(renderLivePage(STREAM, bcSettings().pageText.live, site, { settings: bcSettings() }), { url: "https://boxs.example/site/live/", runScripts: "outside-only" });
    const win = dom.window as unknown as Window & typeof globalThis & { Hls?: unknown };
    const doc = dom.window.document;
    const video = doc.querySelector("video")!;
    const fetchMock = vi.fn(async (_url: unknown) => new Response("{}"));
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    dom.window.setInterval = (() => 0) as unknown as typeof setInterval;
    const srcSets: string[] = [];
    Object.defineProperty(video, "src", { configurable: true, get: () => srcSets.at(-1) ?? "", set: (v: string) => { srcSets.push(v); } });
    video.canPlayType = ((t: string) => (t === "application/vnd.apple.mpegurl" ? native : "")) as typeof video.canPlayType;
    const play = vi.fn(opts.play ?? (async () => {}));
    video.play = play as unknown as typeof video.play;
    dom.window.eval(SITE_SCRIPT);
    const hlsScripts = () => [...doc.querySelectorAll("script")].filter((s) => /vendor\/hls\.light\.min\.js$/.test(s.getAttribute("src") ?? ""));
    const hls = { loadSource: vi.fn(), attachMedia: vi.fn(), on: vi.fn(), instances: 0 };
    const installHls = () => {
      win.Hls = class { static Events = { ERROR: "hlsError" }; static isSupported = () => true; constructor() { hls.instances++; } loadSource = hls.loadSource; attachMedia = hls.attachMedia; on = hls.on; };
    };
    return { dom, doc, win, video, fetchMock, srcSets, play, hlsScripts, hls, installHls, button: doc.querySelector<HTMLButtonElement>("button.play-button")!, status: doc.getElementById("live-status")! };
  }

  it("no fetch or src for the stream host before the click", () => {
    const p = livePlayer("maybe");
    expect(p.fetchMock.mock.calls.filter(([u]) => String(u).includes("stream.example"))).toEqual([]);
    expect(p.srcSets).toEqual([]);
    expect(p.hlsScripts()).toHaveLength(0);
    expect(p.video.hidden).toBe(true);
    expect(p.doc.querySelector<HTMLElement>(".placeholder-container")!.hidden).toBe(false);
    expect(p.play).not.toHaveBeenCalled();
  });

  it("play with native HLS: placeholder hidden, video shown, video.src is the stream, play() called, no script", async () => {
    const p = livePlayer("maybe");
    p.button.click();
    await settle();
    expect(p.doc.querySelector<HTMLElement>(".placeholder-container")!.hidden).toBe(true);
    expect(p.video.hidden).toBe(false);
    expect(p.srcSets).toEqual([STREAM]);
    expect(p.play).toHaveBeenCalledTimes(1);
    expect(p.hlsScripts()).toHaveLength(0);
    expect(p.status.textContent).toBe("");
  });

  it("play without native HLS: appends one script for assets/vendor/hls.light.min.js (even on a second press), then new Hls().loadSource(stream), attachMedia(video), play()", async () => {
    const p = livePlayer("");
    p.button.click();
    p.button.click();
    const scripts = p.hlsScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.getAttribute("src")).toBe("/site/assets/vendor/hls.light.min.js");
    expect(p.srcSets).toEqual([]);
    p.installHls();
    scripts[0]!.dispatchEvent(new p.dom.window.Event("load"));
    await settle();
    expect(p.hls.instances).toBe(1);
    expect(p.hls.loadSource).toHaveBeenCalledWith(STREAM);
    expect(p.hls.attachMedia).toHaveBeenCalledWith(p.video);
    expect(p.play).toHaveBeenCalledTimes(1);
    expect(p.status.textContent).toBe("");
  });

  it("error: a script that fails to load, an unsupported Hls, a fatal hls error and a rejected play() all set #live-status to the fallback text", async () => {
    const failed = livePlayer("");
    failed.button.click();
    failed.hlsScripts()[0]!.dispatchEvent(new failed.dom.window.Event("error"));
    expect(failed.status.textContent).toBe(ERROR_TEXT);

    const unsupported = livePlayer("");
    unsupported.button.click();
    (unsupported.win as unknown as { Hls: unknown }).Hls = class { static isSupported = () => false; };
    unsupported.hlsScripts()[0]!.dispatchEvent(new unsupported.dom.window.Event("load"));
    expect(unsupported.status.textContent).toBe(ERROR_TEXT);

    const fatal = livePlayer("");
    fatal.button.click();
    fatal.installHls();
    fatal.hlsScripts()[0]!.dispatchEvent(new fatal.dom.window.Event("load"));
    const onError = fatal.hls.on.mock.calls.find(([ev]) => ev === "hlsError")![1] as (e: string, d: { fatal: boolean }) => void;
    onError("hlsError", { fatal: false });
    expect(fatal.status.textContent).toBe("");
    onError("hlsError", { fatal: true });
    expect(fatal.status.textContent).toBe(ERROR_TEXT);

    const rejected = livePlayer("maybe", { play: async () => { throw new Error("NotAllowedError"); } });
    rejected.button.click();
    await settle();
    expect(rejected.status.textContent).toBe(ERROR_TEXT);

    const media = livePlayer("maybe");
    media.button.click();
    media.video.dispatchEvent(new media.dom.window.Event("error"));
    expect(media.status.textContent).toBe(ERROR_TEXT);
  });

  it("a page with no .play-button (off air, any other page) is untouched", () => {
    const dom = new JSDOM(renderLivePage(null, bcSettings().pageText.live, site, {}), { url: "https://boxs.example/site/live/", runScripts: "outside-only" });
    expect(() => dom.window.eval(SITE_SCRIPT)).not.toThrow();
  });
});
