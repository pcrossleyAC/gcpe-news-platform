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

  it("one h1; policy link and intro from settings; a details block per network with links, ids facebook\u2026blogs and rss", () => {
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
    expect([...body.querySelectorAll(":scope > details")].map((d) => d.id)).toEqual(["facebook", "x", "instagram", "threads", "bluesky", "linkedin", "flickr", "youtube", "blogs", "rss"]);
    const fb = body.querySelector("details#facebook")!;
    expect(fb.className).toBe("expandable-section facebook expanded");
    expect(fb.hasAttribute("open")).toBe(true);
    expect(fb.querySelector(":scope > summary > h2")?.textContent?.trim()).toBe("Find us on Facebook");
    expect(fb.querySelector(".expandable-section-content > .expander-body > ul.external-links > li > a")).not.toBeNull();
    expect(doc.querySelector("details#linkedin li a")?.getAttribute("href")).toBe("https://www.linkedin.com/company/bcgov/");
  });

  it("no policy link or intro when unset; a network with no links is left out", () => {
    const s = { ...settings, connect: { ...settings.connect, policyLink: { text: "", url: "" }, intro: "", threads: { featured: [], accounts: [] } } };
    const doc = render(s);
    expect(doc.querySelector(".home-body > p")).toBeNull();
    expect(doc.querySelector("#threads")).toBeNull();
  });

  it("x uses class twitter; headings are the legacy ones; no target=_blank; no .article-fade", () => {
    const html = renderConnectPage(sub, { settings }, feeds, []);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("details#x")!.classList.contains("twitter")).toBe(true);
    expect([...doc.querySelectorAll("details > summary > h2")].map((h) => h.textContent?.trim())).toEqual([
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
    const items = [...doc.querySelectorAll("details#x li")];
    expect(items.map((li) => li.textContent)).toEqual(["@Zeta Featured & first", "@beta ", "<b>A</b> <script>x</script>"]);
    expect(items[2]!.querySelector("a")).toBeNull();
    expect(doc.querySelector("main b, main script")).toBeNull();
  });

  it("RSS Feeds: lists the given feeds in order with their hrefs", () => {
    const doc = render();
    const rss = doc.querySelector("details.expandable-section.rss#rss")!;
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
