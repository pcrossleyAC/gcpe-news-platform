import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { NETWORKS, type NetworkKey, type SiteSettings } from "@gcpe/site-settings";
import { bcSettings } from "../../test/fixtures";
import { connectStrip } from "./connect-strip";

const parse = (html: string) => new JSDOM(`<body>${html}</body>`).window.document;
function withAccounts(...keys: NetworkKey[]): SiteSettings {
  const s = bcSettings();
  for (const { key: k } of NETWORKS) s.connect[k] = { featured: [], accounts: [] };
  for (const k of keys) s.connect[k] = { featured: [], accounts: [{ text: `@${k}`, url: `https://${k}.example/bc` }] };
  return s;
}

describe("connectStrip", () => {
  it("lists networks with accounts plus RSS in rows of five, as news.gov's two lists (the flex row would shrink nine icons); LinkedIn appears with BC defaults; RSS alt is 'RSS'; labels from navigation", () => {
    const doc = parse(connectStrip(bcSettings(), "/site"));
    const box = doc.querySelector("div.resource-links.connect")!;
    expect(box.querySelector(":scope > h2")?.textContent).toBe("Connect With Us");
    const rows = [...box.querySelectorAll(":scope > ul")];
    expect(rows.map((ul) => ul.querySelectorAll(":scope > li").length)).toEqual([5, 4]);
    const links = [...box.querySelectorAll("ul > li > a")];
    expect(links.map((a) => [a.id, a.getAttribute("href"), a.querySelector("img")!.getAttribute("alt")])).toEqual([
      ["connectFacebook", "/site/connect/#facebook", "Facebook"],
      ["connectTwitter", "/site/connect/#x", "X"],
      ["connectInstagram", "/site/connect/#instagram", "Instagram"],
      ["connectThread", "/site/connect/#threads", "Threads"],
      ["connectBluesky", "/site/connect/#bluesky", "Bluesky"],
      ["connectLinkedin", "/site/connect/#linkedin", "LinkedIn"],
      ["connectFlickr", "/site/connect/#flickr", "Flickr"],
      ["connectYoutube", "/site/connect/#youtube", "YouTube"],
      ["connectRss", "/site/connect/#rss", "RSS"],
    ]);
    const rss = links[8]!.querySelector("img")!;
    expect(rss.getAttribute("src")).toBe("/site/assets/legacy/Content/Images/SocialMedia/rss-logo.svg");
    expect([rss.getAttribute("width"), rss.getAttribute("height")]).toEqual(["22", "22"]);
    const all = box.querySelector("a#connectAllSocialMedia.read-more")!;
    expect([all.getAttribute("href"), all.textContent]).toEqual(["/site/connect/", "View all Social Media"]);
  });

  it("RSS is always present; a network with no accounts is left out; labels come from settings", () => {
    const s = withAccounts("linkedin");
    s.navigation.labels.connectWithUs = "Find us";
    s.navigation.labels.viewAllSocialMedia = "Everything";
    const doc = parse(connectStrip(s, ""));
    expect([...doc.querySelectorAll("li img")].map((i) => i.getAttribute("alt"))).toEqual(["LinkedIn", "RSS"]);
    expect(doc.querySelector("h2")?.textContent).toBe("Find us");
    expect(doc.querySelector("a.read-more")?.textContent).toBe("Everything");
    expect(doc.querySelector("#connectLinkedin img")!.getAttribute("src")).toContain("linkedin-logo-blue.svg");
    expect(doc.querySelectorAll("ul")).toHaveLength(1);
    const none = parse(connectStrip(withAccounts(), ""));
    expect([...none.querySelectorAll("li img")].map((i) => i.getAttribute("alt"))).toEqual(["RSS"]);
  });
});
