import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, site } from "../../test/fixtures";
import { renderConnectPage } from "./connect";

describe("Connect page", () => {
  const settings = bcSettings();

  it("is accessible, with one h1 and a heading per network that has links, in network order", () => {
    const doc = expectAccessibleStructure(renderConnectPage({ ...site, baseUrl: "https://boxs.example/site" }, { settings }));
    expect(doc.querySelector("h1")?.textContent).toBe("Connect with Us");
    expect([...doc.querySelectorAll("main h2")].map((h) => [h.id, h.textContent])).toEqual([
      ["facebook", "Facebook"],
      ["x", "X"],
      ["instagram", "Instagram"],
      ["threads", "Threads"],
      ["bluesky", "Bluesky"],
      ["linkedin", "LinkedIn"],
      ["flickr", "Flickr"],
      ["youtube", "YouTube"],
      ["blogs", "Blogs"],
    ]);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://boxs.example/site/connect/");
  });

  it("lists featured first as stored, then the other accounts sorted by text, each with its summary", () => {
    const doc = expectAccessibleStructure(
      renderConnectPage(site, {
        settings: {
          ...settings,
          connect: {
            ...settings.connect,
            x: {
              featured: [{ text: "@Zeta", url: "https://x.com/zeta", summary: "Featured & first" }],
              accounts: [{ text: "@beta", url: "https://x.com/beta" }, { text: "@Alpha", url: "https://x.com/alpha", summary: "Alpha news" }],
            },
          },
        },
      }),
    );
    const items = [...doc.querySelectorAll('section[aria-labelledby="x"] li')];
    expect(items.map((li) => li.querySelector("a")?.textContent)).toEqual(["@Zeta", "@Alpha", "@beta"]);
    expect(items[0]!.querySelector("a")?.getAttribute("href")).toBe("https://x.com/zeta");
    expect(items[0]!.querySelector("p")?.textContent).toBe("Featured & first");
    expect(items[2]!.querySelector("p")).toBeNull();
  });

  it("omits a network with no links", () => {
    const doc = expectAccessibleStructure(renderConnectPage(site, { settings: { ...settings, connect: { ...settings.connect, threads: { featured: [], accounts: [] } } } }));
    expect(doc.querySelector("#threads")).toBeNull();
  });

  it("an unvalidated document: markup is text, an unsafe URL is not a link", () => {
    const html = renderConnectPage(site, {
      settings: { ...settings, connect: { ...settings.connect, x: { featured: [], accounts: [{ text: "<b>X</b>", url: "javascript:alert(1)", summary: "<script>alert(1)</script>" }] } } },
    });
    const doc = expectAccessibleStructure(html);
    expect(html).not.toContain("javascript:");
    expect(doc.querySelector("main b, main script")).toBeNull();
    const li = doc.querySelector('section[aria-labelledby="x"] li')!;
    expect(li.querySelector("a")).toBeNull();
    expect(li.textContent).toContain("<b>X</b>");
  });
});
