import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { expectAccessibleStructure, withoutChromeScripts } from "../../test/structure";
import { link, ministry, site } from "../../test/fixtures";
import type { MinisterDto, MinistryProfileDto } from "../dto";
import { bioHtml, hasBiography, ministerCard, ministrySidebar, PREMIER_KEY, renderBiographyPage } from "./minister";

const health = ministry({
  key: "Health",
  name: "Health",
  topicLinks: [link({ uri: "https://gov.example/topic", key: "Clinic topics" })],
  serviceLinks: [link({ uri: "https://gov.example/service", key: "Find a clinic" })],
});
const minister = (over: Partial<MinisterDto> = {}): MinisterDto => ({
  headline: "Hon. Alex Example",
  summary: "Minister of Health.\nMLA for Victoria.",
  details: "<p>Alex was elected in 2020.</p>",
  photo: "https://gov.example/alex.jpg",
  ...over,
});
const profile = (over: Partial<MinistryProfileDto> = {}): MinistryProfileDto => ({ key: "health", ministerEmail: "HLTH.Minister@gov.bc.ca", teamLinks: [], childKeys: [], ...over });
const frag = (html: string) => new JSDOM(`<body>${html}</body>`).window.document.body;
const texts = (d: ParentNode, sel: string) => [...d.querySelectorAll(sel)].map((el) => el.textContent?.trim());

describe("ministerCard", () => {
  it("card: photo alt, headline, summary paragraphs, Read Bio only with a biography, Contact email only when the profile has one", () => {
    const card = frag(ministerCard(site, health, minister(), profile(), {})).querySelector("div.resource-links.minister")!;
    expect(card).not.toBeNull();
    const img = card.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://gov.example/alex.jpg");
    expect(img.getAttribute("alt")).toBe("Hon. Alex Example");
    expect(texts(card, "h2")).toEqual(["Hon. Alex Example"]);
    expect(texts(card, ":scope > p:not(.minister-email)")).toEqual(["Minister of Health.", "MLA for Victoria."]);
    const bio = card.querySelector("a.read-more")!;
    expect(bio.getAttribute("href")).toBe("/ministries/health/biography/");
    expect(bio.innerHTML).toBe('Read Bio<span class="visually-hidden">: Hon. Alex Example</span>');
    expect(texts(card, "h3")).toEqual(["Contact"]);
    const email = card.querySelector("p.minister-email")!;
    expect(email.textContent).toBe("Email: HLTH.Minister@gov.bc.ca");
    expect(email.querySelector("a")!.getAttribute("href")).toBe("mailto:HLTH.Minister@gov.bc.ca");

    // No biography: no Read Bio. No profile, or no email: no Contact.
    const bare = frag(ministerCard(site, health, minister({ details: "  <p> </p> " }), null));
    expect(bare.querySelector("a.read-more")).toBeNull();
    expect(bare.querySelector("h3")).toBeNull();
    expect(bare.querySelector(".minister-email")).toBeNull();
    expect(frag(ministerCard(site, health, minister(), profile({ ministerEmail: null }))).querySelector(".minister-email")).toBeNull();
    // No photo: no img. An unsafe photo is dropped too.
    expect(frag(ministerCard(site, health, minister({ photo: null }), null)).querySelector("img")).toBeNull();
    expect(frag(ministerCard(site, health, minister({ photo: "javascript:alert(1)" }), null)).querySelector("img")).toBeNull();
  });

  it("escapes the email, headline and summary; a ministry heading makes the headline an h3", () => {
    const html = ministerCard(site, health, minister({ headline: 'A "<b>" & B', summary: "<script>x</script>" }), profile({ ministerEmail: 'a"<b>@x.ca' }), { ministryHeading: true });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    const card = frag(html);
    expect(card.querySelector("h2 > a")!.getAttribute("href")).toBe("/ministries/health/");
    expect(texts(card, "h2")).toEqual(["Health"]);
    expect(texts(card, "h3")[0]).toBe('A "<b>" & B');
    expect(card.querySelector("img")!.getAttribute("alt")).toBe('A "<b>" & B');
  });

  it("blank minister headline and no biography → no card", () => {
    expect(ministerCard(site, health, minister({ headline: "  ", details: null }), profile())).toBe("");
    expect(ministerCard(site, health, minister({ headline: null, details: "<p></p>" }), profile())).toBe("");
    expect(ministerCard(site, health, null, profile())).toBe("");
  });

  it("blank minister headline with a biography → the card still links Read Bio (the bio page is never orphaned), named like the bio page", () => {
    const named = ministry({ key: "Health", name: "Health", ministerName: "Hon. Pat Doe" });
    const card = frag(ministerCard(site, named, minister({ headline: " " }), profile())).querySelector("div.resource-links.minister")!;
    expect(card).not.toBeNull();
    expect(texts(card, "h2")).toEqual(["Hon. Pat Doe"]);
    expect(card.querySelector("a.read-more")?.getAttribute("href")).toBe("/ministries/health/biography/");
    expect(card.querySelector("a.read-more")?.textContent).toBe("Read Bio: Hon. Pat Doe");
    // No ministerName either: the ministry name, as the bio page's h1.
    const bare = frag(ministerCard(site, { ...health, ministerName: null }, minister({ headline: null }), profile()));
    expect(texts(bare, "div.minister h2")).toEqual(["Health"]);
    expect(expectAccessibleStructure(renderBiographyPage(named, minister({ headline: " " }), profile(), site)).querySelector("h1")?.textContent).toBe("Hon. Pat Doe");
  });

  it("ministrySidebar: a labelled section with the ministry name as a hidden-from-AT title", () => {
    const s = frag(ministrySidebar(site, health, minister(), null, "<p>extra</p>")).querySelector("section.home-features")!;
    expect(s.getAttribute("aria-label")).toBe("About Health");
    expect(s.querySelector(":scope > p.ministry-title")!.getAttribute("aria-hidden")).toBe("true");
    expect(s.querySelector(":scope > p.ministry-title")!.textContent).toBe("Health");
    expect(s.querySelector(".resource-links.minister")).not.toBeNull();
    expect(s.lastElementChild!.textContent).toBe("extra");
  });
});

describe("bioHtml and hasBiography", () => {
  it("plain-text details with newlines become paragraphs", () => {
    expect(bioHtml("First line.\r\n\r\nSecond & <b>third\nFourth</b> <x-unknown>")).toBe("<p>First line.</p><p>Second &amp; <b>third</b></p><p>Fourth</p>");
    // HTML with block elements is left as the sanitiser gives it.
    expect(bioHtml("<p>One</p>\n<p>Two</p>")).toBe("<p>One</p>\n<p>Two</p>");
    // (headings then shifted so the shallowest is h2: see the heading-shift test)
    expect(bioHtml("<h2>Career</h2>Elected in 2020.")).toBe("<h2>Career</h2>Elected in 2020.");
    expect(bioHtml(null)).toBe("");
  });

  it("hasBiography is true only when the bio has text", () => {
    expect(hasBiography(null)).toBe(false);
    expect(hasBiography(minister({ details: null }))).toBe(false);
    expect(hasBiography(minister({ details: "<p></p>" }))).toBe(false);
    expect(hasBiography(minister({ details: "<p>&nbsp;</p>" }))).toBe(false);
    expect(hasBiography(minister({ details: "<script>alert(1)</script>" }))).toBe(false);
    expect(hasBiography(minister({ details: "Plain text" }))).toBe(true);
  });
});

describe("renderBiographyPage", () => {
  const page = (over: Partial<MinisterDto> = {}, m = health, p: MinistryProfileDto | null = profile()) => renderBiographyPage(m, minister(over), p, site, {});

  it("bio page: one h1 (the minister's name), .biography-details, .minister-bio-picture img, Featured Topics/Services in the sidebar, 'All News From This Ministry'", () => {
    const html = page();
    const d = expectAccessibleStructure(html);
    expect(texts(d, "h1")).toEqual(["Hon. Alex Example"]);
    expect(d.title).toBe(`Hon. Alex Example | ${site.name}`);
    expect(d.querySelector('link[rel="canonical"]')!.getAttribute("href")).toBe("https://news.example/ministries/health/biography/");
    expect(d.querySelector('meta[name="description"]')!.getAttribute("content")).toBe("Minister of Health.\nMLA for Victoria.");
    expect(d.querySelector('meta[property="og:image"]')!.getAttribute("content")).toBe("https://gov.example/alex.jpg");
    const layout = d.querySelector("main > div.ministry-listing > div.home-layout")!;
    expect(layout).not.toBeNull();
    const side = layout.querySelector(":scope > section.home-features")!;
    expect(side.getAttribute("aria-label")).toBe("About Health");
    expect(side.querySelector(".resource-links.minister")).not.toBeNull();
    expect(texts(side, ".resource-links:not(.minister) > h2")).toEqual(["Featured Topics", "Featured Services"]);
    const details = layout.querySelector(":scope > div.home-body > div.biography-details#main-content-release")!;
    expect(details.firstElementChild!.tagName).toBe("H1");
    expect(details.querySelector(":scope > div.minister-bio-picture > img")!.getAttribute("alt")).toBe("Hon. Alex Example");
    expect(texts(details, ":scope > p")).toEqual(["Alex was elected in 2020."]);
    const more = layout.querySelector(":scope > div.home-body > div.news-control > a.read-more")!;
    expect(more.textContent).toBe("All News From This Ministry");
    expect(more.getAttribute("href")).toBe("/ministries/health/");
  });

  it("premier bio says 'All News From The Premier'", () => {
    const premier = ministry({ key: PREMIER_KEY, name: "Office of the Premier" });
    const d = expectAccessibleStructure(page({}, premier));
    expect(d.querySelector(".news-control a.read-more")!.textContent).toBe("All News From The Premier");
    expect(d.querySelector(".news-control a.read-more")!.getAttribute("href")).toBe(`/ministries/${PREMIER_KEY}/`);
  });

  it("bio HTML with <h1>, <script>, <iframe>, onclick is reduced: still exactly one h1, no script/iframe/on* in the output", () => {
    const html = page({ details: '<h1>Early life</h1><p onclick="steal()">Born <script>alert(1)</script>here.</p><iframe src="https://evil.example"></iframe><img src="x.jpg" onerror="steal()" alt="">' });
    const d = expectAccessibleStructure(html);
    expect(texts(d, "h1")).toEqual(["Hon. Alex Example"]);
    expect(texts(d, ".biography-details h2")).toEqual(["Early life"]);
    const own = withoutChromeScripts(html);
    expect(own).not.toMatch(/<script|<iframe|\son[a-z]+=/i);
    expect(own).not.toContain("alert(1)");
  });

  it("bio headings are shifted so the shallowest becomes h2 under the page h1, keeping their relative levels", () => {
    expect(bioHtml("<h2>Early life</h2><p>a</p><h3>School</h3>")).toBe("<h2>Early life</h2><p>a</p><h3>School</h3>");
    expect(bioHtml("<h4>Early life</h4><p>a</p><h5>School</h5><h4>Career</h4>")).toBe("<h2>Early life</h2><p>a</p><h3>School</h3><h2>Career</h2>");
    expect(bioHtml("<h1>Top</h1><h3>Gap</h3>")).toBe("<h2>Top</h2><h4>Gap</h4>");
    expect(bioHtml("<h6 >Tiny</h6>")).toBe("<h2>Tiny</h2>");
    expect(bioHtml("<p>No headings</p>")).toBe("<p>No headings</p>");
    const d = expectAccessibleStructure(page({ details: "<h3>Early life</h3><p>Born here.</p>" }));
    expect(texts(d, ".biography-details h2")).toEqual(["Early life"]);
  });

  it("no photo: no picture block; no profile: no Contact", () => {
    const d = expectAccessibleStructure(page({ photo: null }, health, null));
    expect(d.querySelector(".minister-bio-picture")).toBeNull();
    expect(d.querySelector(".minister-email")).toBeNull();
  });
});
