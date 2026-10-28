import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderHeader } from "./header";
import type { MenuMinistry } from "./ministry-menu";
import type { PageOptions, SiteInfo } from "./render";
import { readFileSync } from "node:fs";
import { bcSettings } from "../test/fixtures";

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
    expect(doc.querySelectorAll(".live_button")).toHaveLength(1);
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

  it("the nav list is News, Subscribe, then the banner toggle item, hidden until a banner shows (site.js)", () => {
    const doc = header({ ministryMenu: MENU });
    const items = [...doc.querySelectorAll("#sm-nav-ul > li")];
    expect(items.map((li) => li.textContent?.trim())).toEqual(["News", "Subscribe", ""]);
    expect(items[1]!.querySelector("a.nav-link")?.getAttribute("href")).toBe("/site/subscribe/");
    expect(items[2]!.className).toBe("nav-item-link d-none d-md-block");
    expect(items[2]!.hasAttribute("hidden")).toBe(true);
  });

  it("banner toggles: desktop #bannerToggleLink and the phone (i) button, both real buttons controlling #banner, collapsed and hidden", () => {
    for (const opts of [{ ministryMenu: MENU }, { banner: "Blue Bridge" }]) {
      const doc = header(opts);
      const toggles = [...doc.querySelectorAll("button[data-banner-toggle]")];
      expect(toggles.map((b) => b.id)).toEqual(["banner-toggle-sm", "bannerToggleLink"]);
      for (const b of toggles) {
        expect(b.getAttribute("type")).toBe("button");
        expect(b.getAttribute("aria-controls")).toBe("banner");
        expect(b.getAttribute("aria-expanded")).toBe("false");
        expect(b.getAttribute("aria-label")).toBe("Site notices");
        const img = b.querySelector("img")!;
        expect([img.getAttribute("src"), img.getAttribute("alt")]).toEqual(["/site/assets/legacy/Content/Images/banner-toggle.svg", ""]);
        expect(b.parentElement!.hasAttribute("hidden")).toBe(true);
      }
      const sm = doc.querySelector("#banner-toggle-sm")!;
      expect(sm.className).toBe("btn btn-link banner-toggle-btn");
      expect(sm.parentElement!.className).toBe("d-md-none banner-toggle-container");
      // Legacy order: the (i) comes before the hamburger.
      expect(sm.parentElement!.nextElementSibling?.id).toBe("nav-menu-sm");
      expect(doc.querySelector("#bannerToggleLink")!.className).toBe("nav-link");
    }
  });

  it("a ministry key is URL-encoded in its link, then HTML-escaped", () => {
    const doc = header({ ministryMenu: [{ key: 'a/b?c#d&"e', name: "Odd" }] });
    const a = doc.querySelector("#menu a")!;
    expect(a.getAttribute("href")).toBe("/site/ministries/a%2Fb%3Fc%23d%26%22e/");
  });

  it("pageSearchInput (the search page) leaves off both search forms and the drawer, and the phone toggle becomes a link to the page's own box", () => {
    const doc = header({ ministryMenu: MENU, pageSearchInput: "q" });
    expect(doc.querySelector("form, #smd-search-container")).toBeNull();
    // Legacy's /search phone header still shows the toggle (R12): same id, classes, icon and slot.
    const link = doc.querySelector("div.search-toggle-container.d-lg-none.page-search > a#search-md-button.input-group-text.btn-primary-outline.search-md.menu-icon")!;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("#q");
    expect(link.getAttribute("aria-label")).toBe("Search");
    expect(link.hasAttribute("data-page-search")).toBe(true);
    expect(link.querySelector("use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-search");
    // Not a toggle: nothing for it to expand.
    expect(link.hasAttribute("aria-controls") || link.hasAttribute("aria-expanded")).toBe(false);
    expect(link.parentElement!.previousElementSibling?.id).toBe("nav-menu-sm");
    expect([...doc.querySelectorAll("[aria-controls]:not([data-banner-toggle])")].map((t) => t.id)).toEqual(["nav-menu-sm"]);
    expect(doc.querySelector("#news-dropdown")?.getAttribute("href")).toBe("/site/ministries/");
  });

  it("pageSearchInput is escaped into the link's fragment", () => {
    const doc = header({ pageSearchInput: 'a"b<c' });
    expect(doc.getElementById("search-md-button")!.getAttribute("href")).toBe('#a"b<c');
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
    // The banner toggles control render.ts's #banner, outside the header (their own test above;
    // expectAccessibleStructure checks their target on every rendered page).
    const toggles = [...doc.querySelectorAll("[aria-controls]:not([data-banner-toggle])")];
    expect(toggles.map((t) => t.id)).toEqual(["nav-menu-sm", "search-md-button"]);
    for (const t of toggles) {
      expect(t.tagName).toBe("BUTTON");
      expect(t.getAttribute("type")).toBe("button");
      expect(doc.getElementById(t.getAttribute("aria-controls")!), t.id).not.toBeNull();
      expect(t.getAttribute("aria-expanded")).toBe("false");
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

describe("renderHeader from Navigation settings", () => {
  const golden = JSON.parse(readFileSync(new URL("../test/golden/header-before-task10.json", import.meta.url), "utf8")) as Record<string, string>;
  const LIVE = `<a id="live-button" href="/site/live/" class="btn btn-primary-blue live_button live_button_hide d-none d-lg-block">Live Webcast</a>`;
  const withNav = (patch: Record<string, unknown>) => {
    const s = bcSettings();
    return { ...s, navigation: { ...s.navigation, ...patch } };
  };

  it("with the BC defaults the header is byte-identical to before, plus the Live button after #sm-nav-container's content", () => {
    const GOLDEN_MENU: MenuMinistry[] = [{ key: "health", name: "Health" }, { key: "finance", name: "Finance & <Co>" }]; // what the golden file was captured with
    const html = (opts: PageOptions) => renderHeader(site, { settings: bcSettings(), ...opts });
    // The Live button is the one addition: it follows #sm-nav-container, inside the nav.
    expect(html({ ministryMenu: GOLDEN_MENU }).replace(`\n${LIVE}`, "")).toBe(golden.menu);
    expect(html({ ministryMenu: GOLDEN_MENU, banner: "x" }).replace(`\n${LIVE}`, "")).toBe(golden.bridge);
    expect(html({}).replace(`\n${LIVE}`, "")).toBe(golden.nomenu);
    expect(html({ ministryMenu: GOLDEN_MENU, pageSearchInput: "q" }).replace(`\n${LIVE}`, "")).toBe(golden.searchPage);
  });

  it("News label, header links (base path, ids) and the Live button (hidden class, base path, settings label)", () => {
    const settings = withNav({
      newsLabel: "Latest <News>",
      liveLabel: "Watch \"live\"",
      headerLinks: [
        { id: "hdrA", text: "Subscribe & more", url: "/subscribe/" },
        { text: "Gov", url: "https://gov.example/x" },
        { text: "Bad", url: "javascript:alert(1)" },
      ],
    }) as never;
    const doc = header({ ministryMenu: MENU, settings });
    expect(doc.querySelector("#news-dropdown")?.textContent).toBe("Latest <News>");
    const items = [...doc.querySelectorAll("#sm-nav-ul > li.nav-item")].slice(1, 4);
    expect(items.map((li) => li.textContent)).toEqual(["Subscribe & more", "Gov", "Bad"]);
    const links = items.map((li) => li.querySelector("a.nav-link"));
    expect(links[0]?.id).toBe("hdrA");
    expect(links[0]?.getAttribute("href")).toBe("/site/subscribe/");
    expect(links[1]?.getAttribute("href")).toBe("https://gov.example/x");
    expect(links[2]).toBeNull(); // unsafe: plain text, no link
    const live = doc.querySelector("#live-button")!;
    expect(live.tagName).toBe("A");
    expect(live.getAttribute("href")).toBe("/site/live/");
    expect(live.className).toBe("btn btn-primary-blue live_button live_button_hide d-none d-lg-block");
    expect(live.textContent).toBe('Watch "live"');
    expect(live.previousElementSibling?.id).toBe("sm-nav-container");
  });

  it("showHeaderSearch false: no header search form, no phone toggle or drawer", () => {
    const doc = header({ ministryMenu: MENU, settings: withNav({ showHeaderSearch: false }) as never });
    expect(doc.querySelector("form, #smd-search-container, #search-md-button, .search-toggle-container")).toBeNull();
    // The search page keeps its own toggle link to its own box (pageSearchInput rule unchanged).
    const onSearch = header({ pageSearchInput: "q", settings: withNav({ showHeaderSearch: false }) as never });
    expect(onSearch.querySelector("a#search-md-button")?.getAttribute("href")).toBe("#q");
  });
});
