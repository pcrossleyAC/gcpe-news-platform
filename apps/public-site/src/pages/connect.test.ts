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
    expect(fb.className).toBe("expandable-section facebook expanded");
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
    expect(items.map((li) => li.textContent)).toEqual(["@Zeta Featured & first", "@beta ", "<b>A</b> <script>x</script>"]);
    expect(items[2]!.querySelector("a")).toBeNull();
    expect(doc.querySelector("main b, main script")).toBeNull();
  });

  it("without script every entry renders, none hidden, and no button; long lists are marked for site.js to collapse (all but Blogs and lists of 2 or fewer)", () => {
    const html = renderConnectPage(sub, { settings }, feeds, []);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("main button")).toBeNull();
    expect(doc.querySelector("main [hidden]")).toBeNull();
    const marked = [...doc.querySelectorAll("div.expandable-section[data-collapsible]")].map((d) => d.id);
    const counts = (id: string) => doc.querySelectorAll(`#${id} li`).length;
    expect(marked).toEqual(["facebook", "x", "instagram", "linkedin", "youtube"]);
    for (const id of marked) expect(counts(id)).toBeGreaterThan(2);
    for (const id of ["threads", "bluesky", "flickr", "blogs", "rss"]) expect(doc.querySelector(`#${id}`)!.hasAttribute("data-collapsible")).toBe(false);
    expect(doc.querySelector("#facebook")!.getAttribute("data-list-name")).toBe("Facebook");
    expect(doc.querySelector("#x")!.getAttribute("data-list-name")).toBe("X");
    // Each marked list has an id for the button's aria-controls.
    expect(doc.querySelector("#facebook ul.external-links")!.id).toBe("facebook-list");
  });

  it("a long RSS list is marked too, named RSS", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ title: `Feed ${i}`, href: `/site/f${i}.xml` }));
    const doc = render(settings, many);
    expect(doc.querySelector("#rss")!.getAttribute("data-list-name")).toBe("RSS");
    expect(doc.querySelector("#rss")!.hasAttribute("data-collapsible")).toBe(true);
    expect(doc.querySelector("#rss ul")!.id).toBe("rss-list");
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
    expect([...sec.querySelectorAll("li")].map((li) => li.querySelector("a")?.getAttribute("href") ?? null)).toEqual(["/site/contacts/", null]);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://boxs.example/site/connect/");
  });
});
