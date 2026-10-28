import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderHeader } from "./header";
import type { MenuMinistry } from "./ministry-menu";
import type { PageOptions, SiteInfo } from "./render";

const site: SiteInfo = { name: "BC Gov News", baseUrl: "https://boxs.example/site" };
const MENU: MenuMinistry[] = [
  { key: "office-of-the-premier", name: "Office of the Premier" },
  { key: "agriculture", name: "Agriculture & <Food>" },
  { key: "health", name: "Health" },
];

const header = (opts: PageOptions = {}, s: SiteInfo = site) => new JSDOM(`<!doctype html><body>${renderHeader(s, opts)}</body>`).window.document;

describe("renderHeader", () => {
  it("is header#main-nav > div#main-nav-container > nav.navbar[aria-label=Main menu] with no id, and the brand is not an h1", () => {
    const doc = header({ ministryMenu: MENU });
    const h = doc.querySelector("header")!;
    expect(h.id).toBe("main-nav");
    expect(h.className).toBe("container-fluid sm-g-0 header nav-border");
    const nav = h.querySelector(":scope > div#main-nav-container.container-xl.sm-g-0 > nav")!;
    expect(nav.className).toBe("navbar navbar-expand-md");
    expect(nav.getAttribute("aria-label")).toBe("Main menu");
    expect(nav.hasAttribute("id")).toBe(false);
    const brand = doc.querySelector("a.navbar-brand.ps-3")!;
    expect(brand.getAttribute("href")).toBe("/site/");
    expect(brand.textContent).toBe("BC Gov News");
    expect(doc.querySelector("h1")).toBeNull();
    expect(doc.querySelector("header [aria-label*=Live], .live_button")).toBeNull();
  });

  it("logo pair links to gov.bc.ca with alt text; bridge variants when Blue Bridge is on", () => {
    const logos = (opts: PageOptions) => {
      const a = header(opts).querySelector('a[href="https://gov.bc.ca"]')!;
      return [...a.querySelectorAll("img")].map((i) => [i.id, i.className, i.getAttribute("src"), i.getAttribute("alt")]);
    };
    expect(logos({})).toEqual([
      ["BCGov-logo", "d-none d-md-block", "/site/assets/legacy/Content/Images/Gov/BCID_H_rgb_pos_LH_crop.svg", "Government of B.C."],
      ["sm-BCGov-logo", "d-md-none", "/site/assets/legacy/Content/Images/Gov/BC_Mark.svg", "Government of B.C."],
    ]);
    expect(logos({ banner: null })).toEqual(logos({}));
    expect(logos({ banner: "Project Blue Bridge" })).toEqual([
      ["BCGov-logo", "d-none d-md-block", "/site/assets/legacy/Content/Images/Gov/BCID_H_rgb_pos_LH_crop_bridge.svg", "Government of B.C."],
      ["sm-BCGov-logo", "d-md-none", "/site/assets/legacy/Content/Images/Gov/BC_Mark_bridge.svg", "Government of B.C."],
    ]);
  });

  it("the News link goes to /ministries/ with the base path; #menu lists exactly the menu's ministries, escaped, in order", () => {
    const html = renderHeader(site, { ministryMenu: MENU });
    expect(html).not.toContain("<Food>");
    const doc = header({ ministryMenu: MENU });
    const news = doc.querySelector("li#ministry-dropdown.nav-item.ministry-dropdown > a#news-dropdown.nav-link")!;
    expect(news.getAttribute("href")).toBe("/site/ministries/");
    expect(news.getAttribute("data-menu")).toBe("menu");
    expect(news.textContent).toBe("News");
    const menu = doc.querySelector("div#menu.container-fluid.collapse > div.menu.container-xl")!;
    expect(menu.querySelector("h2.list-title")?.textContent).toBe("By Ministry");
    expect([...menu.querySelectorAll("ul > li > a")].map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["/site/ministries/office-of-the-premier/", "Office of the Premier"],
      ["/site/ministries/agriculture/", "Agriculture & <Food>"],
      ["/site/ministries/health/", "Health"],
    ]);
    expect(doc.querySelector("#sm-menu")).toBeNull();
    // At the root mount the base path is empty.
    expect(header({ ministryMenu: MENU }, { ...site, baseUrl: "https://boxs.example" }).querySelector("#news-dropdown")?.getAttribute("href")).toBe("/ministries/");
  });

  it.each([
    ["null", null],
    ["absent", undefined],
    ["empty", []],
  ] as const)("ministryMenu %s: News is a plain link to /ministries/, with no #menu and no data-menu", (_, ministryMenu) => {
    const doc = header(ministryMenu === undefined ? {} : { ministryMenu: ministryMenu as MenuMinistry[] | null });
    const news = doc.querySelector("#news-dropdown")!;
    expect(news.tagName).toBe("A");
    expect(news.getAttribute("href")).toBe("/site/ministries/");
    expect(news.hasAttribute("data-menu")).toBe(false);
    expect(doc.querySelector("#menu")).toBeNull();
  });

  it("Subscribe link, and the hidden banner toggle as a labelled button with an empty-alt image", () => {
    const doc = header({ ministryMenu: MENU });
    const sub = [...doc.querySelectorAll("#sm-nav-ul li.nav-item > a.nav-link")].find((a) => a.textContent === "Subscribe")!;
    expect(sub.getAttribute("href")).toBe("/site/subscribe/");
    const toggle = doc.querySelector("button#bannerToggleLink.nav-link")!;
    expect(toggle.hasAttribute("hidden")).toBe(true);
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-controls")).toBe("banner");
    expect(toggle.getAttribute("aria-label")).toBe("Show site notice");
    const img = toggle.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/site/assets/legacy/Content/Images/banner-toggle.svg");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("no role=menu or menuitem anywhere; every id in the header is unique", () => {
    for (const opts of [{ ministryMenu: MENU }, {}, { banner: "B", ministryMenu: MENU }]) {
      const html = renderHeader(site, opts);
      expect(html).not.toMatch(/role="menu(item)?"/);
      const ids = [...header(opts).querySelectorAll("[id]")].map((el) => el.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("both search forms are role=search, GET {base}/search/ with input name q and an associated label", () => {
    const doc = header({ ministryMenu: MENU });
    const forms = [...doc.querySelectorAll("form")];
    expect(forms).toHaveLength(2);
    const desktop = doc.querySelector("form.d-flex.search.d-none.d-lg-block")!;
    expect(desktop.closest("#smd-search-container")).toBeNull();
    const drawer = doc.querySelector("div#smd-search-container.container-fluid.collapse.d-lg-none form")!;
    for (const [form, id] of [[desktop, "mini-site-search-input"], [drawer, "site-search-input"]] as const) {
      expect(form.getAttribute("role")).toBe("search");
      // Named, so the search page's own (unnamed) search landmark is distinct (axe landmark-unique).
      expect(form.getAttribute("aria-label")).toBe("Site search");
      expect(form.getAttribute("action")).toBe("/site/search/");
      expect(form.getAttribute("method")).toBe("get");
      const input = form.querySelector("input")!;
      expect(input.id).toBe(id);
      expect(input.getAttribute("name")).toBe("q");
      expect(input.classList.contains("form-control")).toBe(true);
      const label = form.querySelector(`label[for="${id}"]`)!;
      expect(label.className).toBe("visually-hidden");
      expect(label.textContent).toBe("Search news");
      const submit = form.querySelector("button.input-group-text.btn-primary-outline.search-trigger")!;
      expect(submit.getAttribute("type")).toBe("submit");
      expect(submit.getAttribute("aria-label")).toBe("Search");
      expect(submit.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-search");
    }
  });

  it("every toggle is a <button type=button> with aria-controls pointing at an element that exists", () => {
    const doc = header({ ministryMenu: MENU });
    // #banner (the banner toggle's target) is the page's banner wrapper, outside the header.
    const toggles = [...doc.querySelectorAll("[aria-controls]")];
    expect(toggles.map((t) => t.id)).toEqual(["nav-menu-sm", "search-md-button", "bannerToggleLink"]);
    for (const t of toggles) {
      expect(t.tagName).toBe("BUTTON");
      expect(t.getAttribute("type")).toBe("button");
      if (t.id !== "bannerToggleLink") {
        expect(doc.getElementById(t.getAttribute("aria-controls")!), t.id).not.toBeNull();
        expect(t.getAttribute("aria-expanded")).toBe("false");
      }
    }
    const burger = doc.querySelector("button#nav-menu-sm.navbar-toggler")!;
    expect([burger.getAttribute("aria-controls"), burger.getAttribute("aria-label")]).toEqual(["navbarSupportedContent", "Menu"]);
    expect(burger.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-bars");
    const search = doc.querySelector("button#search-md-button.search-md.menu-icon")!;
    expect([search.getAttribute("aria-controls"), search.getAttribute("aria-label")]).toEqual(["smd-search-container", "Search"]);
    expect(search.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-search");
    expect(doc.querySelector("div#navbarSupportedContent.collapse.navbar-collapse > ul#sm-nav-ul.navbar-nav")).not.toBeNull();
  });
});
