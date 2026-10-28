import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, link, site } from "../../test/fixtures";
import { renderConnectPage } from "./connect";

const feeds = [
  { title: "BC Gov News", href: "/site/feed.xml" },
  { title: "Health", href: "/site/ministries/health/feed.xml" },
];
const sub = { ...site, baseUrl: "https://boxs.example/site" };

describe("Connect page", () => {
  const settings = bcSettings();
  const render = (s = settings, f = feeds, links = [link({})], st = sub) => expectAccessibleStructure(renderConnectPage(st, { settings: s }, f, links));

  it("one h1; policy link and intro from settings; a section block per network with links, ids facebook\u2026blogs and rss", () => {
    const s = { ...settings, connect: { ...settings.connect, intro: "Line one\nLine <two>" } };
    const doc = render(s);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const body = doc.querySelector("div.connect#connect-content > div.home-layout > div.home-body#main-content-release")!;
    expect(body.querySelector("h1")?.textContent).toBe("Connect");
    const policy = body.querySelector(":scope > p > a")!;
    expect(policy.getAttribute("href")).toBe(settings.connect.policyLink.url);
    expect(policy.textContent).toBe(settings.connect.policyLink.text);
    const intro = body.querySelector("p.connect-intro")!;
    expect(intro.innerHTML).toBe("Line one<br>Line &lt;two&gt;");
    expect([...body.querySelectorAll(":scope > div.expandable-section")].map((d) => d.id)).toEqual(["facebook", "x", "instagram", "threads", "bluesky", "linkedin", "flickr", "youtube", "blogs", "rss"]);
    const fb = body.querySelector("div.expandable-section#facebook")!;
    expect(fb.className).toBe("expandable-section facebook collapsed");
    expect(fb.querySelector(":scope > h2")?.textContent?.trim()).toBe("Find us on Facebook");
    expect(fb.querySelector(":scope > h2 > svg.connect-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(fb.querySelector(":scope > h2 use")?.getAttribute("href")).toBe("/site/assets/site/icons.svg#i-square-facebook");
    expect(fb.querySelector(":scope > h2 img")).toBeNull();
    expect(fb.querySelector(".expandable-section-content > .expander-body > ul.external-links > li > a")).not.toBeNull();
    expect(doc.querySelector("div.expandable-section#linkedin li a")?.getAttribute("href")).toBe("https://www.linkedin.com/company/bcgov/");
  });

  it("no policy link or intro when unset; a network with no links is left out", () => {
    const s = { ...settings, connect: { ...settings.connect, policyLink: { text: "", url: "" }, intro: "", threads: { featured: [], accounts: [] } } };
    const doc = render(s);
    expect(doc.querySelector(".home-body > p")).toBeNull();
    expect(doc.querySelector("#threads")).toBeNull();
  });

  it("an unsafe policy link URL leaves its text, with no href", () => {
    const s = { ...settings, connect: { ...settings.connect, policyLink: { text: "Our policy", url: "javascript:alert(1)" } } };
    const html = renderConnectPage(sub, { settings: s }, feeds, []);
    expect(html).not.toContain("javascript:");
    const doc = expectAccessibleStructure(html);
    const p = doc.querySelector(".home-body > h1 + p")!;
    expect(p.textContent).toBe("Our policy");
    expect(p.querySelector("a")).toBeNull();
  });

  it("x uses class twitter; headings are the legacy ones; no target=_blank; no .article-fade", () => {
    const html = renderConnectPage(sub, { settings }, feeds, []);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("div.expandable-section#x")!.classList.contains("twitter")).toBe(true);
    expect([...doc.querySelectorAll(".expandable-section > h2")].map((h) => h.textContent?.trim())).toEqual([
      "Find us on Facebook",
      "Follow us on X",
      "Find us on Instagram",
      "Find us on Threads",
      "Find us on Bluesky",
      "Find us on LinkedIn",
      "See Photos in Flickr",
      "Watch us on YouTube",
      "Blogs and Engagement Sites",
      "RSS Feeds",
    ]);
    expect(html).not.toContain("_blank");
    expect(html).not.toContain("article-fade");
  });

  it("lists featured first as stored, then the others by text, each with its summary; unsafe URL is text", () => {
    const s = {
      ...settings,
      connect: {
        ...settings.connect,
        x: {
          featured: [{ text: "@Zeta", url: "https://x.com/zeta", summary: "Featured & first" }],
          accounts: [{ text: "@beta", url: "https://x.com/beta" }, { text: "<b>A</b>", url: "javascript:alert(1)", summary: "<script>x</script>" }],
        },
      },
    };
    const html = renderConnectPage(sub, { settings: s }, feeds, []);
    expect(html).not.toContain("javascript:");
    const doc = expectAccessibleStructure(html);
    const items = [...doc.querySelectorAll("div.expandable-section#x li")];
    expect(items.map((li) => li.textContent)).toEqual(["@Zeta Featured & first", "@beta", "<b>A</b> <script>x</script>"]);
    expect(items[2]!.querySelector("a")).toBeNull();
    expect(doc.querySelector("main b, main script")).toBeNull();
  });

  it("long lists are marked collapsed for CSS (html.js) with the Expand button in the markup; every entry is rendered and none [hidden]", () => {
    const html = renderConnectPage(sub, { settings }, feeds, []);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("main [hidden]")).toBeNull();
    const marked = [...doc.querySelectorAll("div.expandable-section[data-collapsible]")].map((d) => d.id);
    expect(marked).toEqual(["facebook", "x", "instagram", "linkedin", "youtube"]);
    for (const id of marked) {
      const sec = doc.getElementById(id)!;
      expect(sec.className).toBe(`expandable-section ${id === "x" ? "twitter" : id} collapsed`);
      expect(sec.getAttribute("data-collapsible")).toBe("2");
      const lis = [...sec.querySelectorAll("li")];
      expect(lis.length).toBeGreaterThan(2);
      expect(lis.map((li) => li.className)).toEqual(lis.map((_, i) => (i === 1 ? "collapse-last" : i >= 2 ? "collapse-extra" : "")));
      // The button follows the list's wrapper; overrides.css shows it only under html.js (site.js wires it).
      const btn = sec.querySelector(":scope > .expandable-section-content + button.link-button.expand-toggle")!;
      expect([btn.getAttribute("type"), btn.getAttribute("aria-expanded"), btn.getAttribute("aria-controls"), btn.textContent]).toEqual([
        "button", "false", `${id}-list`, `Expand ${id === "x" ? "X" : sec.getAttribute("data-list-name")} list`,
      ]);
      expect(doc.getElementById(`${id}-list`)).toBe(sec.querySelector("ul.external-links"));
    }
    expect(doc.querySelector("#facebook")!.getAttribute("data-list-name")).toBe("Facebook");
    // BC's Blogs list (collapseAfter 0) and lists of two or fewer are open, with no button or marks.
    for (const id of ["threads", "bluesky", "flickr", "blogs", "rss"]) {
      const sec = doc.getElementById(id)!;
      expect(sec.className).toMatch(/ expanded$/);
      expect(sec.hasAttribute("data-collapsible")).toBe(false);
      expect(sec.querySelector("button, li[class]")).toBeNull();
    }
    expect(doc.querySelectorAll("#blogs li").length).toBeGreaterThan(2);
  });

  it("collapseAfter per network: 0 never collapses, 3 keeps three (the third faded), absent keeps two", () => {
    const s = { ...settings, connect: { ...settings.connect, facebook: { ...settings.connect.facebook, collapseAfter: 0 }, x: { ...settings.connect.x, collapseAfter: 3 }, blogs: { ...settings.connect.blogs, collapseAfter: undefined } } };
    const doc = render(s);
    expect(doc.querySelector("#facebook")!.hasAttribute("data-collapsible")).toBe(false);
    expect(doc.querySelector("#facebook button")).toBeNull();
    expect(doc.querySelector("#x")!.getAttribute("data-collapsible")).toBe("3");
    expect([...doc.querySelectorAll("#x li")].slice(0, 4).map((li) => li.className)).toEqual(["", "", "collapse-last", "collapse-extra"]);
    expect(doc.querySelector("#blogs")!.getAttribute("data-collapsible")).toBe("2");
    expect(doc.querySelector("#blogs button")?.textContent).toBe("Expand Blogs list");
  });

  it("a summary span only beside a link that has a summary (overrides.css underlines exactly those links)", () => {
    const s = { ...settings, connect: { ...settings.connect, x: { featured: [{ text: "@Zeta", url: "https://x.com/zeta", summary: "News" }], accounts: [{ text: "@beta", url: "https://x.com/beta" }, { text: "@gamma", url: "https://x.com/gamma", summary: " " }] } } };
    const doc = render(s);
    expect([...doc.querySelectorAll("#x li")].map((li) => li.innerHTML)).toEqual([
      '<a href="https://x.com/zeta">@Zeta</a> <span>News</span>',
      '<a href="https://x.com/beta">@beta</a>',
      '<a href="https://x.com/gamma">@gamma</a>',
    ]);
  });

  it("a long RSS list is marked too, named RSS, collapsing after two", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ title: `Feed ${i}`, href: `/site/f${i}.xml` }));
    const doc = render(settings, many);
    expect(doc.querySelector("#rss")!.getAttribute("data-list-name")).toBe("RSS");
    expect(doc.querySelector("#rss")!.getAttribute("data-collapsible")).toBe("2");
    expect(doc.querySelector("#rss ul")!.id).toBe("rss-list");
    expect(doc.querySelector("#rss button")?.textContent).toBe("Expand RSS list");
  });

  it("RSS Feeds: lists the given feeds in order with their hrefs", () => {
    const doc = render();
    const rss = doc.querySelector("div.expandable-section.rss#rss")!;
    expect([...rss.querySelectorAll("li a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["BC Gov News", "/site/feed.xml"],
      ["Health", "/site/ministries/health/feed.xml"],
    ]);
  });

  it("Resources section beside the body from resource links", () => {
    const doc = render(settings, feeds, [link({ uri: "/contacts/", key: "Media Contacts" }), link({ uri: "javascript:alert(1)", key: "Evil" })]);
    const sec = doc.querySelector(".home-layout > section.home-features[aria-label='Resources']")!;
    expect(sec.querySelector(".resource-links h2")?.textContent).toBe("Resources");
    // resources-box: overrides.css drops the underline on its link-only rows, as legacy.
    expect(sec.querySelector(":scope > div.resource-links.resources-box")).not.toBeNull();
    expect([...sec.querySelectorAll("li")].map((li) => li.querySelector("a")?.getAttribute("href") ?? null)).toEqual(["/site/contacts/", null]);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://boxs.example/site/connect/");
  });
});
