import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { MenuMinistry } from "./ministry-menu";
import { renderPage, type PageOptions } from "./render";
import { SITE_SCRIPT } from "./site-script";

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

  it("on the search page (no header search) the remaining toggles still work", () => {
    const { doc } = page({ ministryMenu: MENU, hideHeaderSearch: true });
    expect(doc.getElementById("search-md-button")).toBeNull();
    doc.getElementById("news-dropdown")!.click();
    expect(doc.getElementById("menu")!.classList.contains("show")).toBe(true);
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

    it("dismissal is not persisted", () => {
      const first = page({ ministryMenu: MENU, banner: "Blue Bridge" });
      first.doc.getElementById("btnCloseBannerBridge")!.click();
      const again = page({ ministryMenu: MENU, banner: "Blue Bridge" });
      expect(again.doc.getElementById("banner")!.hidden).toBe(false);
      expect(SITE_SCRIPT).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    });
  });
});
