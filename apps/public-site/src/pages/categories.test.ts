import { describe, expect, it } from "vitest";
import { expectAccessibleStructure, withoutChromeScripts } from "../../test/structure";
import { bcSettings, category, contact, ministry, post, site } from "../../test/fixtures";
import { renderCategoryPage, renderMinistryFactsheetsPage, renderMinistryPage, type MinistryPageContext } from "./categories";
import type { MinisterDto, MinistryProfileDto } from "../dto";

const emptyPosts = { top: null, feature: null, latest: [] };

describe("renderMinistryPage", () => {
  const minister = (over: Partial<MinisterDto> = {}): MinisterDto => ({ headline: "Hon. Alex Example", summary: "Minister of Health.", details: "<p>Alex was elected in 2020.</p>", photo: "https://files.example/files/minister.jpg", ...over });
  const profile = (over: Partial<MinistryProfileDto> = {}): MinistryProfileDto => ({ key: "health", ministerEmail: "HLTH.Minister@gov.example", teamLinks: [], childKeys: [], ...over });
  const noCtx: MinistryPageContext = { profile: null, children: [] };
  const regions = (doc: Document) => doc.querySelector("main .collapsible-regions");
  const regionHeadings = (doc: Document) => [...(regions(doc)?.querySelectorAll(":scope > .resource-links > h2") ?? [])].map((h) => h.textContent);

  it("one h1.ministry-name-mobile; section.home-features[aria-label] with the minister card; .home-body with PostCards; no <aside>", () => {
    const top = post({ key: "T1" });
    const feature = post({ key: "F1" });
    const latest = [1, 2, 3, 4, 5].map((i) => post({ key: `L${i}` }));
    const doc = expectAccessibleStructure(renderMinistryPage(ministry(), minister(), { top, feature, latest }, site, {}, { profile: profile(), children: [] }));
    const h1s = doc.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toBe("ministry-name-mobile");
    expect(h1s[0]!.textContent).toBe("Health");
    const main = doc.querySelector("main")!;
    expect(main.querySelector("aside")).toBeNull();
    const listing = main.querySelector(".pt-2.ministry-listing > .home-layout")!;
    expect(listing).not.toBeNull();
    const features = listing.querySelector(":scope > section.home-features")!;
    expect(features.getAttribute("aria-label")).toBe("About Health");
    const card = features.querySelector(".resource-links.minister")!;
    expect(card.querySelector("h2")?.textContent).toBe("Hon. Alex Example");
    expect(card.querySelector("img")?.getAttribute("alt")).toBe("Hon. Alex Example");
    expect(card.querySelector("a.read-more")?.getAttribute("href")).toBe("/ministries/health/biography/");
    expect(card.querySelector(".minister-email a")?.getAttribute("href")).toBe("mailto:HLTH.Minister@gov.example");
    const body = listing.querySelector(":scope > .home-body#main-content-release")!;
    expect([...listing.children].map((c) => c.className)).toEqual(["home-body", "home-features"]);
    expect(body.querySelector(".top-article > .article a[href='/releases/T1/']")).not.toBeNull();
    expect(body.querySelector(".feature-article > .article a[href='/releases/F1/']")).not.toBeNull();
    const cards = [...body.querySelectorAll(".other-articles > #regular-articles.regular-articles > .article")];
    expect(cards).toHaveLength(5);
    expect(cards.map((c) => c.classList.contains("hidden-article"))).toEqual([false, false, false, true, true]);
    expect(body.querySelector(".news-control button.load-more[aria-controls='regular-articles']")?.textContent).toBe("Load More News");
    expect(body.querySelector("p > a[href='/archive/']")?.textContent).toBe("Browse the archive by month");
    // Every legacy h3/h4 is one level up: no heading skips a level after the h1.
    const levels = [...doc.querySelectorAll("main h1, main h2, main h3, main h4")].map((h) => Number(h.tagName[1]));
    levels.forEach((l, i) => i > 0 && expect(l - levels[i - 1]!).toBeLessThanOrEqual(1));
  });

  it("three or fewer latest: no Load More button, nothing hidden", () => {
    const doc = expectAccessibleStructure(renderMinistryPage(ministry(), null, { top: null, feature: null, latest: [post({ key: "L1" })] }, site, {}, noCtx));
    expect(doc.querySelector("button.load-more")).toBeNull();
    expect(doc.querySelector(".hidden-article")).toBeNull();
  });

  // boxs.ca: the v1 Ministries list carries contacts as Core's contact record
  // ({fullName, phoneNumber, mobileNumber, emailAddress}). Legacy (Views/Shared/Ministry.cshtml +
  // CommContact.cshtml): name, then "Direct: <phone>", "Cell: <mobile>", a mailto link; "Alternate:"
  // before the second contact; "After hours: <number>" last; the whole block only when the first contact exists.
  it("Media Contacts from contactUser/secondContactUser/weekendContactNumber in .collapsible-regions; none without a primary contact", () => {
    const m = ministry({
      contactUser: contact({ fullName: "Alex <Example>", phoneNumber: "250-555-0100", mobileNumber: "250-555-0101", emailAddress: "alex@example.test" }),
      secondContactUser: contact({ fullName: "Jordan Example", phoneNumber: "250-555-0200", mobileNumber: null, emailAddress: "jordan@example.test" }),
      weekendContactNumber: "250-555-0199",
    });
    const doc = expectAccessibleStructure(renderMinistryPage(m, null, emptyPosts, site, {}, noCtx));
    expect(regionHeadings(doc)[0]).toBe("Media Contacts");
    const box = regions(doc)!.querySelector(":scope > .resource-links")!;
    const names = [...box.querySelectorAll(".contact-name")].map((n) => n.textContent);
    expect(names).toEqual(["Alex <Example>", "Jordan Example"]);
    const text = box.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Direct: 250-555-0100");
    expect(text).toContain("Cell: 250-555-0101");
    expect(text).toContain("Direct: 250-555-0200");
    expect(text.match(/Cell:/g)).toHaveLength(1);
    expect([...box.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["mailto:alex@example.test", "alex@example.test"],
      ["mailto:jordan@example.test", "jordan@example.test"],
    ]);
    expect(text.indexOf("Alex")).toBeLessThan(text.indexOf("Alternate:"));
    expect(text.indexOf("Alternate:")).toBeLessThan(text.indexOf("Jordan"));
    expect(text.indexOf("Jordan")).toBeLessThan(text.indexOf("After hours: 250-555-0199"));

    const without = renderMinistryPage(ministry({ contactUser: null, secondContactUser: contact({ fullName: "Jordan Example" }), weekendContactNumber: "250-555-0199" }), null, emptyPosts, site, {}, noCtx);
    expect(without).not.toContain("Media Contacts");
    expect(without).not.toContain("After hours");
    expect(renderMinistryPage(ministry({ contactUser: contact({}) }), null, emptyPosts, site, {}, noCtx)).not.toContain("Media Contacts");
    const nameOnly = renderMinistryPage(ministry({ contactUser: contact({ fullName: "Alex Example" }) }), null, emptyPosts, site, {}, noCtx);
    expect(nameOnly).toContain("Media Contacts");
    expect(nameOnly).not.toContain("Direct:");
    expect(nameOnly).not.toContain("mailto:");
  });

  it("a contact email the safe-URL check refuses as a mailto: is shown as text, not linked (as the minister email)", () => {
    const html = renderMinistryPage(ministry({ contactUser: contact({ fullName: "Alex", emailAddress: "alex example@gov.example" }) }), null, emptyPosts, site, {}, noCtx);
    const box = regions(expectAccessibleStructure(html))!.querySelector(":scope > .resource-links")!;
    expect(box.querySelector("a[href^='mailto:']")).toBeNull();
    expect(box.textContent).toContain("alex example@gov.example");
  });

  it("escapes every contact value, including inside the mailto link", () => {
    const html = withoutChromeScripts(
      renderMinistryPage(ministry({ contactUser: contact({ fullName: "A <b>", phoneNumber: "<i>1</i>", mobileNumber: null, emailAddress: 'x"><script>alert(1)</script>@example.test' }), weekendContactNumber: "<u>9</u>" }), null, emptyPosts, site, {}, noCtx),
    );
    expect(html).toContain("A &lt;b&gt;");
    expect(html).toContain("Direct: &lt;i&gt;1&lt;/i&gt;");
    expect(html).toContain('href="mailto:x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@example.test"');
    expect(html).toContain("After hours: &lt;u&gt;9&lt;/u&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("Meet the Team from profile.teamLinks (unsafe url dropped); absent profile or [] → no Meet the Team", () => {
    const teamLinks = [
      { text: "Cabinet Ministers", url: "https://www2.gov.example/cabinet" },
      { text: "<b>Evil</b>", url: "javascript:alert(1)" },
      { text: "Deputy & Ministers", url: "/deputies" },
    ];
    const doc = expectAccessibleStructure(renderMinistryPage(ministry(), null, emptyPosts, { ...site, baseUrl: "https://boxs.example/site" }, {}, { profile: profile({ teamLinks }), children: [] }));
    const team = [...regions(doc)!.querySelectorAll(":scope > .resource-links")].find((b) => b.querySelector("h2")?.textContent === "Meet the Team")!;
    expect(team).toBeDefined();
    expect([...team.querySelectorAll("ul > li > a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Cabinet Ministers", "https://www2.gov.example/cabinet"],
      ["Deputy & Ministers", "/site/deputies"],
    ]);
    expect(doc.documentElement.outerHTML).not.toContain("javascript:");
    expect(doc.documentElement.outerHTML).not.toContain("<b>Evil");
    for (const ctx of [noCtx, { profile: profile({ teamLinks: [] }), children: [] }, { profile: profile({ teamLinks: [{ text: "X", url: "javascript:x" }] }), children: [] }]) {
      expect(renderMinistryPage(ministry(), null, emptyPosts, site, {}, ctx)).not.toContain("Meet the Team");
    }
  });

  it("collapsible regions in legacy order: Media Contacts, Meet the Team, More from this Ministry, Featured Topics, Featured Services, then ministers of state", () => {
    const m = ministry({
      flickrUri: "https://flickr.com/health",
      youtubeUri: "https://youtube.com/health",
      contactUser: contact({ fullName: "Alex Example" }),
      topicLinks: [{ key: "Wait times", uri: "https://gov.example/wait" }],
      serviceLinks: [{ key: "Find a doctor", uri: "https://gov.example/doctor" }],
    });
    const child = { ministry: ministry({ key: "child-care", name: "Minister of State for Child Care" }), minister: minister({ headline: "Hon. Sam Example" }), profile: null };
    const doc = expectAccessibleStructure(
      renderMinistryPage(m, null, emptyPosts, site, { settings: bcSettings() }, { profile: profile({ teamLinks: [{ text: "Cabinet", url: "https://gov.example/c" }] }), children: [child] }),
    );
    expect(regionHeadings(doc)).toEqual(["Media Contacts", "Meet the Team", "More from this Ministry", "Featured Topics", "Featured Services", "Minister of State for Child Care"]);
    const more = [...regions(doc)!.querySelectorAll(":scope > .resource-links")][2]!;
    expect([...more.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Factsheets", "/ministries/health/factsheets/"],
      ["Ministry Website", "https://gov.example/health"],
      ["Ministry Photos", "https://flickr.com/health"],
      ["Ministry Videos", "https://youtube.com/health"],
    ]);
  });

  it("uses the settings' headings and link labels; drops javascript:/data: side links and escapes their text", () => {
    const settings = bcSettings();
    const renamed = { ...settings, ministryPages: { ...settings.ministryPages, mediaContacts: "Press <Office>", moreFromMinistry: "Around Health", ministryWebsite: "Home site", featuredTopics: "Topics", featuredServices: "Services" } };
    const m = ministry({
      ministryUrl: "http://gov.bc.ca/health",
      flickrUri: "javascript:alert(1)",
      youtubeUri: "data:text/html,x",
      contactUser: contact({ fullName: "Alex Example" }),
      topicLinks: [{ key: "<b>Bad</b>", uri: "javascript:alert(2)" }, { key: "A & <B>", uri: "http://gov.example/ok" }, { key: "Local", uri: "/subscribe" }],
      serviceLinks: [{ key: "Evil", uri: "data:text/html,y" }],
    });
    const html = renderMinistryPage(m, null, emptyPosts, { ...site, baseUrl: "https://boxs.example/site" }, { settings: renamed }, noCtx);
    const doc = expectAccessibleStructure(html);
    expect(regionHeadings(doc)).toEqual(["Press <Office>", "Around Health", "Topics"]);
    expect(html).toContain('href="http://gov.bc.ca/health">Home site');
    expect(html).toContain('href="http://gov.example/ok">A &amp; &lt;B&gt;');
    expect(html).toContain('href="/site/subscribe">Local');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("Ministry Photos");
  });

  it("office-of-the-premier: 'More from the Premier'; other ministries use labels.moreFromMinistry", () => {
    const premier = renderMinistryPage(ministry({ key: "office-of-the-premier", name: "Office of the Premier" }), null, emptyPosts, site, {}, noCtx);
    expect(regionHeadings(expectAccessibleStructure(premier))).toContain("More from the Premier");
    expect(premier).not.toContain("More from this Ministry");
    const settings = bcSettings();
    const other = renderMinistryPage(ministry(), null, emptyPosts, site, { settings: { ...settings, ministryPages: { ...settings.ministryPages, moreFromMinistry: "Around Health" } } }, noCtx);
    expect(regionHeadings(expectAccessibleStructure(other))).toContain("Around Health");
    expect(other).not.toContain("More from the Premier");
  });

  it("a child ministry renders a minister-of-state card: ministry name linked, minister, Read Bio to the child's biography URL", () => {
    const child = { ministry: ministry({ key: "Child-Care", name: "Minister of State for Child Care" }), minister: minister({ headline: "Hon. Sam Example", summary: "Minister of State." }), profile: profile({ key: "child-care", ministerEmail: "cc@gov.example" }) };
    const noMinister = { ministry: ministry({ key: "trade", name: "Minister of State for Trade" }), minister: null, profile: null };
    const doc = expectAccessibleStructure(renderMinistryPage(ministry(), minister(), emptyPosts, site, {}, { profile: profile(), children: [child, noMinister] }));
    const cards = [...regions(doc)!.querySelectorAll(".resource-links.minister")];
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.querySelector("h2 > a")?.getAttribute("href")).toBe("/ministries/child-care/");
    expect(card.querySelector("h2 > a")?.textContent).toBe("Minister of State for Child Care");
    expect(card.querySelector("h3")?.textContent).toBe("Hon. Sam Example");
    expect(card.querySelector("a.read-more")?.getAttribute("href")).toBe("/ministries/child-care/biography/");
    expect(card.querySelector(".minister-email a")?.getAttribute("href")).toBe("mailto:cc@gov.example");
    expect(doc.body.textContent).not.toContain("Minister of State for Trade");
  });

  it("profile null (older News API): page renders with card (no email), no Meet the Team, no children", () => {
    const doc = expectAccessibleStructure(renderMinistryPage(ministry(), minister(), emptyPosts, site, {}, noCtx));
    const card = doc.querySelector("section.home-features .resource-links.minister")!;
    expect(card).not.toBeNull();
    expect(card.querySelector("a.read-more")).not.toBeNull();
    expect(doc.documentElement.outerHTML).not.toContain("mailto:");
    expect(doc.body.textContent).not.toContain("Meet the Team");
    expect(doc.body.textContent).not.toContain("undefined");
    expect(doc.querySelectorAll(".resource-links.minister")).toHaveLength(1);
  });

  it("no minister, or a blank headline with no bio: no card, and the page still renders", () => {
    for (const mn of [null, minister({ headline: "  ", details: null })]) {
      const doc = expectAccessibleStructure(renderMinistryPage(ministry(), mn, emptyPosts, site, {}, noCtx));
      expect(doc.querySelector(".resource-links.minister")).toBeNull();
      expect(doc.querySelector("section.home-features")).not.toBeNull();
    }
  });

  it("refuses a javascript: minister photo", () => {
    const html = renderMinistryPage(ministry(), minister({ photo: "javascript:alert(1)" }), emptyPosts, site, {}, noCtx);
    expect(html).not.toContain('src="javascript:');
  });

  it("Load More News and Search News come from navigation.labels", () => {
    const settings = bcSettings();
    settings.navigation.labels = { ...settings.navigation.labels, loadMoreNews: "MORE <b>", searchNews: "SRCH" };
    const html = renderMinistryPage(ministry({ key: "health", name: "Health" }), null, { top: null, feature: null, latest: Array.from({ length: 5 }, (_, i) => post({ key: `L${i}` })) }, site, { settings }, noCtx);
    expect(html).toContain(">MORE &lt;b&gt;</button>");
    expect(html).toContain(">SRCH</a>");
    expect(html).not.toMatch(/Load More News|Search News/);
  });

  it("Search News links /search/?ministry=<key> with the base path", () => {
    const doc = expectAccessibleStructure(renderMinistryPage(ministry({ key: "Health" }), null, emptyPosts, { ...site, baseUrl: "https://boxs.example/site" }, {}, noCtx));
    const search = doc.querySelector(".news-control a.read-more");
    expect(search?.textContent).toBe("Search News");
    expect(search?.getAttribute("href")).toBe("/site/search/?ministry=health");
    expect(doc.querySelector("p > a[href='/site/archive/']")).not.toBeNull();
  });

  it("links the feed alternate at /ministries/<key>/feed.xml", () => {
    expect(renderMinistryPage(ministry({ key: "health" }), null, emptyPosts, site, {}, noCtx)).toContain('href="/ministries/health/feed.xml"');
  });

  it("escapes the ministry name everywhere", () => {
    const html = withoutChromeScripts(renderMinistryPage(ministry({ name: 'A & <B> "C"' }), minister(), emptyPosts, site, {}, noCtx));
    expect(html).toContain("A &amp; &lt;B&gt; &quot;C&quot;");
    expect(html).not.toContain("<B>");
  });
});

describe("renderCategoryPage (Sector.cshtml look)", () => {
  const links = [{ key: "Contact us", uri: "/contacts/" }];
  const render = (kind: "sectors" | "themes" | "tags", c = category(), posts: Parameters<typeof renderCategoryPage>[2] = emptyPosts, l = links) =>
    expectAccessibleStructure(renderCategoryPage(kind, c, posts, l, site, { settings: bcSettings() }));
  const n = (count: number) => Array.from({ length: count }, (_, i) => post({ key: `L${i + 1}`, publishDate: `2026-10-${String(20 - i).padStart(2, "0")}T10:00:00-07:00` }));

  it("sector page: one h1 (the name), .ministry-listing.sector-listing > .home-layout, no <aside>", () => {
    const doc = render("sectors", category({ key: "economy", name: "Economy" }));
    const h1s = doc.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toBe("ministry-name-mobile");
    expect(h1s[0]!.textContent).toBe("Economy");
    expect(doc.querySelector("main .ministry-listing.sector-listing > .home-layout > .home-body#main-content-release")).not.toBeNull();
    expect(doc.querySelector("main aside")).toBeNull();
  });

  it("cards in date order including the top and feature posts once each", () => {
    const top = post({ key: "TOP", publishDate: "2026-10-10T10:00:00-07:00" });
    const feature = post({ key: "FEAT", publishDate: "2026-10-25T10:00:00-07:00" });
    const doc = render("sectors", category(), { top, feature, latest: [...n(2), feature] });
    const cards = [...doc.querySelectorAll(".other-articles > #regular-articles.regular-articles > .article")];
    expect(cards.map((c) => c.querySelector("a")!.getAttribute("href"))).toEqual(["/releases/FEAT/", "/releases/L1/", "/releases/L2/", "/releases/TOP/"]);
    expect(doc.querySelector(".top-article, .feature-article")).toBeNull();
  });

  it("a post that is both top and feature shows once", () => {
    const both = post({ key: "BOTH" });
    const doc = render("tags", category({ kind: "tags" }), { top: both, feature: both, latest: [] });
    expect(doc.querySelectorAll("#regular-articles > .article")).toHaveLength(1);
  });

  it("Search News (labels.searchNews) only for sectors, filtered by sector key", () => {
    const sector = render("sectors", category({ key: "economy" }));
    const a = sector.querySelector('main .news-control a.read-more[href="/search/?sector=economy"]')!;
    expect(a.textContent).toBe(bcSettings().navigation.labels.searchNews);
    for (const kind of ["themes", "tags"] as const) expect(render(kind, category({ kind })).querySelector('main a[href^="/search/"]')).toBeNull();
  });

  it("Load More only when more than 3; Browse the archive stays; the browse-more link is the Load More button's no-script twin", () => {
    expect(render("themes", category({ kind: "themes" }), { ...emptyPosts, latest: n(3) }).querySelector("button.load-more")).toBeNull();
    const doc = render("themes", category({ kind: "themes" }), { ...emptyPosts, latest: n(4) });
    expect(doc.querySelector("button.load-more")!.textContent).toBe(bcSettings().navigation.labels.loadMoreNews);
    expect(doc.querySelector('main p > a[href="/archive/"]')!.textContent).toBe("Browse the archive by month");
  });

  it("the Connect strip and Resources are present; the strip is in section.home-features labelled About {name}", () => {
    const doc = render("sectors", category({ name: "A & B" }));
    const section = doc.querySelector('section.home-features[aria-label="About A & B"]')!;
    expect(section.querySelector('p.ministry-title[aria-hidden="true"]')!.textContent).toBe("A & B");
    expect(section.querySelector("#connectAllSocialMedia")).not.toBeNull();
    expect(doc.querySelector(".home-body .collapsible-regions .resource-links h2")!.textContent).toBe(bcSettings().navigation.labels.resources);
    expect(doc.querySelector('.collapsible-regions a[href="/contacts/"]')).not.toBeNull();
  });

  it("no links: no Resources box, still a collapsible-regions container-free page", () => {
    expect(render("tags", category({ kind: "tags" }), emptyPosts, []).querySelector(".collapsible-regions .resource-links")).toBeNull();
  });

  it("escapes the category name and the key in the search href", () => {
    const html = renderCategoryPage("sectors", category({ key: "a&b", name: "A & <B>" }), emptyPosts, [], site, { settings: bcSettings() });
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).not.toContain("A & <B>");
    expect(html).toContain("/search/?sector=a%26b");
  });
});

describe("renderMinistryFactsheetsPage (H5)", () => {
  const minister: MinisterDto = { headline: "Hon. Alex Example", summary: "Minister of Health.", details: "<p>Bio</p>", photo: null };
  const noCtx: MinistryPageContext = { profile: null, children: [] };
  const facts = (n: number) => Array.from({ length: n }, (_, i) => post({ key: `F${i + 1}`, kind: "factsheets" }));

  it("one h1 (the ministry name), a Factsheets heading, cards, the minister card in the side column, Search News with type and ministry", () => {
    const doc = expectAccessibleStructure(renderMinistryFactsheetsPage(ministry(), minister, facts(5), site, { settings: bcSettings() }, noCtx));
    expect(doc.title).toContain("Factsheets: Health");
    const h1s = doc.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.className).toBe("ministry-name-mobile");
    expect(h1s[0]!.textContent).toBe("Health");
    const listing = doc.querySelector("main .pt-2.ministry-listing.fact-sheets > .home-layout")!;
    expect(listing).not.toBeNull();
    const heading = listing.querySelector(".home-body h2.listing-title")!;
    expect(heading.textContent).toBe("Factsheets");
    expect(listing.querySelector(".top-article, .feature-article")).toBeNull();
    const cards = [...listing.querySelectorAll("#regular-articles > .article")];
    expect(cards).toHaveLength(5);
    expect(cards.map((c) => c.classList.contains("hidden-article"))).toEqual([false, false, false, true, true]);
    expect(listing.querySelector("button.load-more")?.textContent).toBe("Load More");
    expect(listing.querySelector("section.home-features .resource-links.minister h2")?.textContent).toBe("Hon. Alex Example");
    expect(listing.querySelector(".news-control a.read-more")?.getAttribute("href")).toBe("/search/?type=factsheets&ministry=health");
    expect(listing.querySelector(".news-control a.read-more")?.textContent).toBe(bcSettings().navigation.labels.searchNews);
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toContain("/ministries/health/factsheets/");
    expect(doc.querySelector('link[rel="alternate"]')?.getAttribute("href")).toContain("/ministries/health/feed.xml");
    expect(doc.querySelector(".collapsible-regions")).not.toBeNull();
  });

  it("no factsheets: an empty message, no Load More, the page still renders", () => {
    const doc = expectAccessibleStructure(renderMinistryFactsheetsPage(ministry(), null, [], site, {}, noCtx));
    expect(doc.querySelector(".listing-empty")?.textContent).toBe("Nothing has been published yet.");
    expect(doc.querySelector("button.load-more")).toBeNull();
    expect(doc.querySelector("h2.listing-title")?.textContent).toBe("Factsheets");
  });

  it("escapes the ministry name in the heading, title and Search News link", () => {
    const html = renderMinistryFactsheetsPage(ministry({ name: "A & <B>", key: "a&b" }), null, [], site, {}, noCtx);
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).not.toContain("<B>");
    expect(html).toContain("ministry=a%26b");
  });

  it("More from this Ministry starts with Factsheets, then the ministry's website, on both ministry pages", () => {
    for (const html of [renderMinistryPage(ministry(), null, emptyPosts, site, {}, noCtx), renderMinistryFactsheetsPage(ministry(), null, [], site, {}, noCtx)]) {
      const doc = expectAccessibleStructure(html);
      const box = [...doc.querySelectorAll(".collapsible-regions > .resource-links")].find((b) => b.querySelector("h2")?.textContent === "More from this Ministry")!;
      const links = [...box.querySelectorAll("a")];
      expect(links[0]!.textContent).toBe("Factsheets");
      expect(links[0]!.getAttribute("href")).toBe("/ministries/health/factsheets/");
    }
  });
});
