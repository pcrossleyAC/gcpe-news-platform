import { describe, expect, it } from "vitest";
import { expectAccessibleStructure, withoutChromeScripts } from "../../test/structure";
import { bcSettings, link, ministry, post, site } from "../../test/fixtures";
import type { PostDocument } from "../dto";
import { documentsByLanguage, renderReleasePage, shareLinks, type ReleaseContext } from "./release";

const health = ministry({
  key: "health",
  name: "Health",
  ministryUrl: "https://gov.example/health",
  flickrUri: "https://flickr.example/health",
  youtubeUri: "https://youtube.example/health",
  topicLinks: [link({ uri: "https://gov.example/topic", key: "Clinic <topics>" })],
  serviceLinks: [link({ uri: "/services/", key: "Find a clinic" })],
});
const ctx: ReleaseContext = { related: [], leadMinistry: health, ministryLatest: [] };
const noMinistry: ReleaseContext = { ...ctx, leadMinistry: null };

const doc = (over: Partial<PostDocument> = {}): PostDocument => ({ languageId: 4105, headline: "H", subheadline: null, detailsHtml: null, contacts: [], ...over });
const render = (over: Parameters<typeof post>[0] = {}, c: ReleaseContext = ctx, opts = {}) => renderReleasePage(post(over), site, opts, c);
const dom = (over: Parameters<typeof post>[0] = {}, c: ReleaseContext = ctx, opts = {}) => expectAccessibleStructure(render(over, c, opts));
const texts = (d: ParentNode, sel: string) => [...d.querySelectorAll(sel)].map((el) => el.textContent?.trim());

describe("documentsByLanguage", () => {
  it("English is 4105 (else any non-French), French is 3084; main falls back to the first French document", () => {
    const en1 = doc({ headline: "en1" });
    const en2 = doc({ headline: "en2" });
    const fr1 = doc({ languageId: 3084, headline: "fr1" });
    const fr2 = doc({ languageId: 3084, headline: "fr2" });
    expect(documentsByLanguage([fr1, en1, fr2, en2])).toEqual({ main: en1, backgrounders: [en2], french: fr1, frenchBackgrounders: [fr2] });
    const other = doc({ languageId: 1033, headline: "other" });
    expect(documentsByLanguage([fr1, other])).toEqual({ main: other, backgrounders: [], french: fr1, frenchBackgrounders: [] });
    expect(documentsByLanguage([fr1, fr2])).toEqual({ main: fr1, backgrounders: [], french: null, frenchBackgrounders: [fr2] });
    expect(documentsByLanguage([])).toEqual({ main: null, backgrounders: [], french: null, frenchBackgrounders: [] });
  });
});

describe("release page", () => {
  it("one h1 (English headline); .story-page > .story-features[aria-label] + .story-body; no <aside>; no duplicate ids", () => {
    const d = dom();
    expect(texts(d, "h1")).toEqual(["Clinics to open across the province"]);
    expect(d.querySelector("h1")!.className).toBe("story-lang primary");
    const page = d.querySelector("main > div.story-page.pt-4")!;
    const side = page.querySelector(":scope > section.story-features#sidebar")!;
    expect(side.getAttribute("aria-label")).toBe("About this release");
    expect(side.nextElementSibling?.matches("div.story-body#main-content-release")).toBe(true);
    expect(d.querySelector("main aside")).toBeNull();
    // The print header: button, site name, canonical URL, long date.
    expect(page.querySelector(":scope > button.print-document[type=button]")?.textContent?.trim()).toBe("Print");
    expect(page.querySelector(".print-title")?.textContent).toBe("BC Gov News");
    expect(page.querySelector(".print-url")?.textContent).toBe("https://news.example/releases/2026HLTH0001-000001/");
    expect(page.querySelector(".print-date")?.textContent).toBe("Saturday, October 3, 2026 10:00 AM");
    // The lead ministry above the headline, as a paragraph (not a heading).
    const ministryLine = page.querySelector(":scope > p.story-ministry > a")!;
    expect(ministryLine.getAttribute("href")).toBe("/ministries/health/");
    expect(ministryLine.textContent).toBe("Health");
    expect(page.querySelector("p.story-lang.primary.subheadline")?.textContent).toBe("Ministry of Health");
  });

  it("kind label from documents[0].pageTitle and the long date with time in .location-and-date", () => {
    const d = dom({ location: "VICTORIA", documents: [doc({ headline: "H", pageTitle: "News Release" })] });
    const box = d.querySelector(".story-features .resource-links.location-and-date")!;
    expect(box.querySelector("h2")?.textContent).toBe("News Release");
    expect(box.querySelector("p.location")?.textContent).toBe("VICTORIA");
    expect(box.querySelector(":scope > div")?.textContent).toBe("Saturday, October 3, 2026 10:00 AM");
    // The phone row carries the same three.
    const phone = d.querySelector(".story-info .mobile-toolbar > .resource-links:not(.share)")!;
    expect(phone.querySelector("h2.story-lang.primary")?.textContent).toBe("News Release");
    expect(phone.querySelector("p")?.textContent).toBe("VICTORIA");
    expect(phone.querySelector("div")?.textContent).toBe("Saturday, October 3, 2026 10:00 AM");
  });

  it("backgrounders: every English document after the first, in order, each with an h3; none → no Backgrounders heading", () => {
    const d = dom({
      documents: [
        doc({ headline: "Main" }),
        doc({ headline: "First <bg>", subheadline: "Sub one", byline: "By A\nand B", detailsHtml: "<p>One.</p>" }),
        doc({ headline: null, detailsHtml: "<p>Two.</p>" }),
      ],
    });
    expect(texts(d, ".story-body > h2")).toContain("Backgrounders");
    const bgs = [...d.querySelectorAll(".story-body > .backgrounder")];
    expect(bgs.map((b) => b.querySelector(".backgrounder-header > h3")?.textContent)).toEqual(["First <bg>", "Backgrounder"]);
    const first = bgs[0]!.querySelector(".backgrounder-content")!;
    expect(first.querySelector("p.subheadline")?.textContent).toBe("Sub one");
    expect(first.querySelector("p > b")?.innerHTML).toBe("By A<br>and B");
    expect(first.innerHTML).toContain("<p>One.</p>");
    expect(bgs[1]!.innerHTML).toContain("<p>Two.</p>");
    const none = dom({ documents: [doc({ headline: "Only" })] });
    expect(none.querySelector(".backgrounder")).toBeNull();
    expect(texts(none, "h2")).not.toContain("Backgrounders");
  });

  it("French document: secondary headline/copy with lang=fr and both language buttons; no French → no .language-selector", () => {
    const d = dom({
      documents: [
        doc({ languageId: 3084, headline: "Cliniques", subheadline: "Sous-titre", byline: "Par A", detailsHtml: "<p>Des cliniques.</p>" }),
        doc({ headline: "Clinics", detailsHtml: "<p>Clinics.</p>" }),
        doc({ headline: "BG" }),
        doc({ languageId: 3084, headline: "Fiche" }),
      ],
    });
    expect(texts(d, "h1")).toEqual(["Clinics"]);
    const fr = d.querySelector("p.story-lang.secondary.story-headline")!;
    expect(fr.getAttribute("lang")).toBe("fr");
    expect(fr.textContent).toBe("Cliniques");
    // A plain paragraph server-side: site.js makes it the level-1 heading only while French shows
    // (P2-R3 F3), so without script the page exposes exactly one level-1 heading.
    expect(fr.hasAttribute("role") || fr.hasAttribute("aria-level")).toBe(false);
    expect(d.querySelector('p.story-lang.secondary.subheadline[lang="fr"]')?.textContent).toBe("Sous-titre");
    const frCopy = d.querySelector('div.story-copy.story-lang.secondary[lang="fr"] > article')!;
    expect(frCopy.innerHTML).toContain("<p>Des cliniques.</p>");
    expect(d.querySelector("div.story-copy.story-lang.primary > article")!.innerHTML).toContain("<p>Clinics.</p>");
    const toFrench = d.querySelector('.language-selector.story-lang.primary button[type=button][data-story-lang="secondary"]')!;
    expect(toFrench.getAttribute("lang")).toBe("fr");
    expect(toFrench.textContent).toBe("français");
    expect(toFrench.parentElement!.textContent).toBe("Cet article est aussi disponible en français");
    const toEnglish = d.querySelector('.language-selector.story-lang.secondary button[type=button][data-story-lang="primary"]')!;
    expect(toEnglish.textContent).toBe("English");
    expect(toEnglish.parentElement!.textContent).toBe("This article also available in English");
    // Bilingual Backgrounders heading; the French backgrounder is secondary.
    const heading = [...d.querySelectorAll(".story-body > h2")].find((h) => h.textContent?.includes("Backgrounders"))!;
    expect(heading.querySelector(".story-lang.primary")?.textContent).toBe("Backgrounders");
    expect(heading.querySelector('.story-lang.secondary[lang="fr"]')?.textContent).toBe("Détails supplémentaires");
    const frBg = d.querySelector('.backgrounder.story-lang.secondary[lang="fr"]')!;
    expect(frBg.querySelector("h3")?.textContent).toBe("Fiche");
    expect(d.querySelectorAll(".backgrounder")).toHaveLength(2);

    // A French document with a blank headline: the French-mode headline falls back to the English one (F4).
    const blankFr = dom({ documents: [doc({ headline: "Clinics" }), doc({ languageId: 3084, headline: " ", detailsHtml: "<p>FR.</p>" })] });
    const fallback = blankFr.querySelector("p.story-lang.secondary.story-headline")!;
    expect(fallback.textContent).toBe("Clinics");
    expect(fallback.hasAttribute("lang")).toBe(false);

    const en = dom({ documents: [doc({ headline: "Clinics" })] });
    expect(en.querySelector(".language-selector")).toBeNull();
    expect(en.querySelector(".story-lang.secondary")).toBeNull();
  });

  it("documents French-before-English, French only, zero documents, null detailsHtml: renders, headline falls back to the key", () => {
    // The default fixture lists French first.
    expect(texts(dom(), "h1")).toEqual(["Clinics to open across the province"]);
    // French only: French is the main document, shown (lang=fr), with no toggle; a second French
    // document is an ordinary, visible backgrounder.
    const frOnly = dom({ documents: [doc({ languageId: 3084, headline: "Cliniques", detailsHtml: "<p>FR.</p>" }), doc({ languageId: 3084, headline: "Fiche" })] });
    expect(texts(frOnly, "h1")).toEqual(["Cliniques"]);
    expect(frOnly.querySelector("h1")!.getAttribute("lang")).toBe("fr");
    expect(frOnly.querySelector(".language-selector")).toBeNull();
    expect(frOnly.querySelector(".story-lang.secondary")).toBeNull();
    expect(frOnly.querySelector('div.story-copy.story-lang.primary[lang="fr"]')!.innerHTML).toContain("<p>FR.</p>");
    expect(frOnly.querySelector('.backgrounder[lang="fr"]:not(.story-lang) h3')?.textContent).toBe("Fiche");
    // Zero documents: the key is the headline, nothing undefined.
    const none = render({ documents: [] });
    const noneDoc = expectAccessibleStructure(none);
    expect(texts(noneDoc, "h1")).toEqual(["2026HLTH0001-000001"]);
    // (The chrome's own scripts legitimately say "null"; the page content must not.)
    expect(withoutChromeScripts(none)).not.toMatch(/undefined|\bnull\b/);
    // A blank headline falls back too; null detailsHtml renders an empty article.
    const blank = dom({ documents: [doc({ headline: "", detailsHtml: null })] });
    expect(texts(blank, "h1")).toEqual(["2026HLTH0001-000001"]);
    expect(blank.querySelector(".story-copy article")).not.toBeNull();
  });

  it("backgrounder contacts shown only when they differ from the main document's", () => {
    const same = { title: "Media", details: "Alex\n250-555-0100" };
    const other = { title: "Ministry of Housing", details: "Sam\n250-555-0199" };
    const d = dom({ documents: [doc({ headline: "Main", contacts: [same] }), doc({ headline: "Same", contacts: [same] }), doc({ headline: "Other", contacts: [same, other] }), doc({ headline: "None" })] });
    const bgs = [...d.querySelectorAll(".backgrounder")];
    expect(bgs.map((b) => b.querySelectorAll(".comm-contact").length)).toEqual([0, 2, 0]);
    expect(texts(bgs[1]!, ".comm-contact h5")).toEqual(["Media", "Ministry of Housing"]);
    // The main document's contacts: the side column and the phone copy, with no ids.
    const side = d.querySelector(".story-features .resource-links.comm-contacts")!;
    expect(side.querySelector("h2")?.textContent).toBe("Media Contacts");
    expect(side.querySelector(".comm-contact > h3")?.textContent).toBe("Media");
    expect(side.querySelector(".comm-contact")!.innerHTML).toContain("Alex<br>250-555-0100");
    const phone = d.querySelector(".story-body .comm-contacts-body-section")!;
    expect(phone.querySelector(".comm-contact > h3")?.textContent).toBe("Media");
    expect(phone.querySelectorAll("[id]")).toHaveLength(0);
  });

  it("a stored document without a contacts array renders without contacts instead of failing", () => {
    const malformed = { ...doc({ headline: "Main" }), contacts: undefined } as unknown as PostDocument;
    const bg = { ...doc({ headline: "Background" }), contacts: null } as unknown as PostDocument;
    const d = dom({ documents: [malformed, bg] });
    expect(d.querySelector(".comm-contacts")).toBeNull();
    expect(texts(d, ".backgrounder-header h3")).toEqual(["Background"]);
  });

  it("Media Assets list: label, Download (n KB) with download attribute; only when hasMediaAssets", () => {
    const d = dom({ hasMediaAssets: true });
    const assets = d.querySelector(".story-body > div#assets.assets.expanded")!;
    expect(assets.querySelector("h2")?.textContent).toBe("Media Assets");
    const items = [...assets.querySelectorAll(".media-assets-container > ul > li")];
    expect(items.map((li) => li.querySelector(":scope > div > b")?.textContent)).toEqual(["Clinic <photo>", "Backgrounder"]);
    const a = items[0]!.querySelector(":scope > div > a[download]")!;
    expect(a.getAttribute("href")).toBe("https://files.example/files/a.png");
    expect(a.textContent).toBe("Download (1 KB)");
    // The side column's link to the list.
    const jump = d.querySelector(".story-features .location-and-date .media-assets > a.assets-link")!;
    expect(jump.getAttribute("href")).toBe("#assets");
    expect(jump.textContent?.trim()).toBe("Media Assets");

    for (const off of [dom({ hasMediaAssets: false }), dom({}), dom({ hasMediaAssets: true, azureAssets: [] })]) {
      expect(off.querySelector("#assets")).toBeNull();
      expect(off.querySelector("a.assets-link")).toBeNull();
    }
  });

  it("translations show language names with lang/hreflang and no target=_blank; #translationList and #translations each appear once", () => {
    const html = render({ azureTranslations: [{ key: "https://files.example/t/zh.pdf", label: "Chinese(Simplified)", length: 10 }, { key: "https://files.example/t/x.pdf", label: "Other", length: 10 }] });
    const d = expectAccessibleStructure(html);
    expect(d.querySelectorAll("#translationList")).toHaveLength(1);
    expect(d.querySelectorAll("#translations")).toHaveLength(1);
    expect(html).not.toContain("_blank");
    const side = d.querySelector(".story-features > div.resource-links.translate#translationList")!;
    expect(side.querySelector("h2")?.textContent).toBe("Translations");
    const zh = side.querySelector("ul > li > a")!;
    expect(zh.getAttribute("href")).toBe("https://files.example/t/zh.pdf");
    expect(zh.getAttribute("hreflang")).toBe("zh-Hans");
    expect(zh.getAttribute("lang")).toBe("zh-Hans");
    expect(zh.textContent).toBe("简体中文");
    expect(zh.querySelector("svg[aria-hidden=true] use")?.getAttribute("href")).toContain("#i-language");
    const unknown = side.querySelectorAll("ul > li > a")[1]!;
    expect(unknown.textContent).toBe("Other");
    expect(unknown.hasAttribute("lang") || unknown.hasAttribute("hreflang")).toBe(false);
    // The phone copy has no id.
    expect(d.querySelector(".story-info .resource-links.translate:not([id]) a")?.textContent).toBe("简体中文");
    const body = d.querySelector(".story-body > div#translations.assets.expanded")!;
    expect(body.querySelector("h2")?.textContent).toBe("Translations");
    expect(texts(body, "ul > li > a[hreflang]")).toEqual(["简体中文"]);

    const none = dom({ azureTranslations: [] });
    expect(none.querySelector("#translationList, #translations, .translate")).toBeNull();
  });

  it("side column from the lead ministry: More from this Ministry, Featured Topics, Featured Services with settings labels; unknown ministry → none", () => {
    const settings = bcSettings();
    const renamed = { ...settings, ministryPages: { ...settings.ministryPages, moreFromMinistry: "Around <Health>", ministryWebsite: "Home site", featuredTopics: "Topics", featuredServices: "Services", mediaContacts: "Press" } };
    const d = dom({ documents: [doc({ pageTitle: "News Release", contacts: [{ title: "Media", details: "Alex" }] })] }, ctx, { settings: renamed });
    const side = d.querySelector(".story-features")!;
    expect(texts(side, ":scope > .resource-links > h2")).toEqual(["Translations", "Share", "News Release", "Press", "Around <Health>", "Topics", "Services"]);
    const more = [...side.querySelectorAll(":scope > .resource-links")].find((b) => b.querySelector("h2")?.textContent === "Around <Health>")!;
    expect([...more.querySelectorAll("li a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Home site", "https://gov.example/health"],
      ["Ministry Photos", "https://flickr.example/health"],
      ["Ministry Videos", "https://youtube.example/health"],
    ]);
    expect(side.textContent).not.toContain("Factsheets");
    expect([...side.querySelectorAll("a")].find((a) => a.textContent === "Find a clinic")?.getAttribute("href")).toBe("/services/");
    expect([...side.querySelectorAll("a")].find((a) => a.textContent === "Clinic <topics>")?.getAttribute("href")).toBe("https://gov.example/topic");

    const unknown = dom({ ministryKeys: ["nope"], leadMinistryKey: "nope" }, noMinistry);
    expect(texts(unknown, ".story-features h2")).not.toContain("More from this Ministry");
    expect(unknown.querySelector("p.story-ministry")).toBeNull();
  });

  it("an inactive lead ministry with no successor (abolished) is named without a link", () => {
    for (const c of [{ ...ctx, leadMinistry: { ...health, isActive: false } }, { ...ctx, leadMinistry: { ...health, isActive: false }, leadMinistrySuccessor: null }]) {
      const d = dom({}, c);
      expect(d.querySelector("p.story-ministry")?.textContent).toBe("Health");
      expect(d.querySelector("p.story-ministry a")).toBeNull();
    }
  });

  it("an inactive lead ministry whose successor resolves links its own page, which the stack 301s to the successor", () => {
    const d = dom({}, { ...ctx, leadMinistry: { ...health, isActive: false }, leadMinistrySuccessor: "health-new" });
    expect(d.querySelector("p.story-ministry a")?.getAttribute("href")).toBe("/ministries/health/");
    expect(d.querySelector("p.story-ministry a")?.textContent).toBe("Health");
  });

  it("a body <asset> YouTube link renders as div.asset.youtube; an <iframe> in the body is dropped", () => {
    const html = render({ documents: [doc({ headline: "Clinics", detailsHtml: '<p>Watch.</p><asset>https://www.youtube.com/watch?v=abc123DEF</asset><iframe src="https://evil.example"></iframe>' })] });
    const d = expectAccessibleStructure(html);
    const yt = d.querySelector(".story-copy article div.asset.youtube > a")!;
    expect(yt.getAttribute("href")).toBe("https://www.youtube.com/watch?v=abc123DEF");
    expect(html).not.toContain("<iframe");
  });

  it("a body Flickr photo link is never nameless: its image has alt \"\" so the link carries visually hidden text", () => {
    const d = dom({ documents: [doc({ headline: "Clinics & more", detailsHtml: "<asset>https://live.staticflickr.com/65535/53912345678_0a1b2c3d4e_b.jpg</asset>" })] });
    const a = d.querySelector(".story-copy div.asset.flickr > a")!;
    expect(a.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(a.querySelector("span.visually-hidden")?.textContent).toBe("Photo: Clinics & more");
  });

  it("staff text can't be hidden with span.visually-hidden; the embed's own hidden name stays; no data-embed reaches the page", () => {
    const html = render({ documents: [doc({ detailsHtml: '<p>Seen <span class="visually-hidden">secret</span> <span data-embed="x" class="visually-hidden">guess</span></p><asset>https://live.staticflickr.com/1/2_ab.jpg</asset>' })] });
    const d = expectAccessibleStructure(html);
    const copy = d.querySelector(".story-copy article")!;
    expect([...copy.querySelectorAll(".visually-hidden")].map((x) => x.closest(".asset.flickr") !== null)).toEqual([true]);
    expect(copy.textContent).toContain("secret");
    expect(html).not.toContain("data-embed");
  });

  it("in-page #fragment links into the same body are kept, prefixed per document so English and French never share an id", () => {
    const body = '<p><a href="#cassidy">Cassidy Cardle</a></p><p><a name="cassidy"></a><strong>Cassidy</strong> is a nurse.</p><p><a href="#gone">gone</a></p>';
    const d = dom({ documents: [doc({ headline: "H", detailsHtml: body }), doc({ languageId: 3084, headline: "F", detailsHtml: body }), doc({ headline: "Bg", detailsHtml: body })] });
    const links = [...d.querySelectorAll(".story-body a[href^='#']")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(expect.arrayContaining(["#body-cassidy", "#body-fr-cassidy", "#bg1-cassidy"]));
    for (const href of links.filter((h) => h !== "#assets" && h !== "#translations")) expect(d.querySelectorAll(href!), href!).toHaveLength(1);
    expect(d.querySelector("a[href='#gone']")).toBeNull();
  });

  it("byline: bold, with line breaks, escaped", () => {
    const d = dom({ documents: [doc({ headline: "H", byline: "Office of <the> Premier\r\nJoint statement" })] });
    expect(d.querySelector(".story-body > p.story-lang.primary.byline > b")?.innerHTML).toBe("Office of &lt;the&gt; Premier<br>Joint statement");
    expect(dom({ documents: [doc({ byline: "  " })] }).querySelector(".byline")).toBeNull();
  });

  it("demotes body headings so the page keeps one h1", () => {
    const html = render({ documents: [doc({ detailsHtml: '<H1 class="x">Inner</H1><h2>Two</h2><h6>Six</h6>' })] });
    const d = expectAccessibleStructure(html);
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    expect(html).toContain("<h2>Inner</h2>");
    expect(html).toContain("<h3>Two</h3>");
    expect(html).toContain("<h6>Six</h6>");
  });

  it("refuses a javascript: asset/translation URL instead of rendering it as a link", () => {
    const html = render({
      hasMediaAssets: true,
      azureAssets: [{ key: "javascript:alert(1)", label: "Evil doc", length: 10 }],
      azureTranslations: [{ key: "javascript:alert(1)", label: "Évil", length: 10 }],
    });
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("Evil doc");
    expect(html).not.toContain("Évil");
    expect(html).not.toContain('id="assets"');
  });

  it("sanitises the body, on top of (not instead of) the headline/field escaping (C209)", () => {
    const html = render({
      documents: [doc({ detailsHtml: '<p>Safe.</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">Click</a><style>body{display:none}</style>' })],
    });
    expect(html).toContain("<p>Safe.</p>");
    expect(withoutChromeScripts(html)).not.toContain("<script");
    expect(withoutChromeScripts(html)).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<style");
    expect(html).toContain("Click");
  });

  it("escapes every interpolated field (headline, asset labels, contacts, location, ministry, links)", () => {
    const html = render(
      {
        hasMediaAssets: true,
        location: "A & <B>",
        documents: [doc({ headline: "Clinics <script>x</script>", pageTitle: '"Release"', contacts: [{ title: "<b>T</b>", details: "x\n<y>" }] })],
      },
      { ...ctx, leadMinistry: { ...health, name: "Health & <Care>" } },
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect(html).toContain("x<br>&lt;y&gt;");
    expect(html).toContain("Clinic &lt;photo&gt;");
    expect(html).toContain("Health &amp; &lt;Care&gt;");
    expect(html).toContain("&quot;Release&quot;");
  });
});

describe("release page: share, social meta, lead media, related band", () => {
  const meta = (d: Document, key: string) => d.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content") ?? null;
  const FLICKR = "https://live.staticflickr.com/65535/53912345678_0a1b2c3d4e_b.jpg";
  const related = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `2026HLTH0100-00010${i}`, headline: `Related ${i} <r>`, publishDate: `2026-09-0${i + 1}T09:00:00-07:00` }));
  const latest = (keys: string[]) => keys.map((key, i) => post({ key, publishDate: `2026-10-0${i + 1}T10:00:00-07:00`, documents: [doc({ headline: `Latest ${key}` })] }));

  it("share hrefs: headline 'Fish & \"Chips\" <é简体>' on base /site → subject percent-encoded, canonical https://news.example/site/releases/K/, no raw < or \" in any attribute", () => {
    const headline = 'Fish & "Chips" <é简体>';
    const html = renderReleasePage(post({ key: "K", documents: [doc({ headline })] }), { ...site, baseUrl: "https://news.example/site" }, {}, ctx);
    const d = expectAccessibleStructure(html);
    const canonical = "https://news.example/site/releases/K/";
    const enc = encodeURIComponent(canonical);
    // Once in the side column (right after Translations) and once in the phone row, first in its toolbar.
    expect(d.querySelectorAll("div.resource-links.connect.share")).toHaveLength(2);
    const blocks = [d.querySelector("section.story-features > div.resource-links.connect.share")!, d.querySelector(".story-info > .mobile-toolbar > div.resource-links.connect.share:first-child")!];
    expect(blocks[0]!.previousElementSibling?.matches(".resource-links.translate")).toBe(true);
    expect(blocks[1]).not.toBeNull();
    for (const block of blocks) {
      expect(block.querySelector(":scope > h2")?.textContent).toBe("Share");
      const links = [...block.querySelectorAll(":scope > ul > li > a")];
      expect(links.map((a) => [a.className, a.getAttribute("href"), a.getAttribute("aria-label")])).toEqual([
        ["share-facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc}`, "Share on Facebook"],
        ["share-twitter", `https://twitter.com/intent/tweet?url=${enc}`, "Share on X"],
        ["share-threads", `https://threads.net/intent/post?text=${enc}`, "Share on Threads"],
        ["share-bluesky", `https://bsky.app/intent/compose?text=${enc}`, "Share on Bluesky"],
        ["", `mailto:?subject=${encodeURIComponent(headline)}&body=${enc}`, "Share by email"],
      ]);
      expect(links.map((a) => a.querySelector("svg[aria-hidden=true] use")?.getAttribute("href"))).toEqual(
        ["facebook", "square-x-twitter", "threads", "bluesky", "envelope"].map((i) => `/site/assets/site/icons.svg#i-${i}`),
      );
    }
    expect(blocks[0]!.querySelector('a[href^="mailto:"]')!.getAttribute("href")).toContain("subject=Fish%20%26%20%22Chips%22%20%3C%C3%A9%E7%AE%80%E4%BD%93%3E&");
    // No raw < or " from the headline anywhere in the source (attributes included): every copy is escaped or percent-encoded.
    expect(html).not.toContain('"Chips"');
    expect(html).not.toContain("<é简体>");
    expect(html).toContain('content="Fish &amp; &quot;Chips&quot; &lt;é简体&gt;"');
    // Plain links: no third-party script or iframe, no target.
    expect(withoutChromeScripts(html)).not.toContain("<script");
    expect(blocks[0]!.querySelector("[target]")).toBeNull();
    // The share-link builder on its own.
    expect(shareLinks(canonical, headline, null, "/site")).toBe(blocks[0]!.outerHTML);
  });

  it("instagram share links the featured account first (legacy: governmentofbc), else the first account (P2-R5)", () => {
    const settings = bcSettings();
    settings.connect.instagram.featured = [{ text: "Government of BC", url: "https://www.instagram.com/governmentofbc/" }];
    settings.connect.instagram.accounts = [{ text: "BC Honours", url: "https://www.instagram.com/bchonours" }];
    expect(dom({}, ctx, { settings }).querySelector("a.share-instagram")?.getAttribute("href")).toBe("https://www.instagram.com/governmentofbc/");
    // The bc tenant's own settings, unchanged.
    expect(dom({}, ctx, { settings: bcSettings() }).querySelector("a.share-instagram")?.getAttribute("href")).toBe("https://www.instagram.com/governmentofbc/");
  });

  it("instagram share only when settings.connect.instagram has an account", () => {
    const settings = bcSettings();
    settings.connect.instagram.featured = [];
    settings.connect.instagram.accounts = [{ text: "Gov", url: "https://www.instagram.com/governmentofbc/" }, { text: "Other", url: "https://www.instagram.com/other/" }];
    const d = dom({}, ctx, { settings });
    const ig = [...d.querySelectorAll("a.share-instagram")];
    expect(ig).toHaveLength(2);
    expect(ig[0]!.getAttribute("href")).toBe("https://www.instagram.com/governmentofbc/");
    // Named by the account it links to.
    expect(ig[0]!.getAttribute("aria-label")).toBe("Gov on Instagram");
    expect(ig[0]!.querySelector("use")?.getAttribute("href")).toContain("#i-instagram");
    // After X, before Threads.
    expect(ig[0]!.parentElement!.previousElementSibling?.querySelector("a.share-twitter")).not.toBeNull();
    settings.connect.instagram.accounts = [];
    expect(dom({}, ctx, { settings }).querySelector("a.share-instagram")).toBeNull();
    expect(dom({}, ctx, {}).querySelector("a.share-instagram")).toBeNull();
    settings.connect.instagram.accounts = [{ text: "Bad", url: "javascript:alert(1)" }];
    expect(dom({}, ctx, { settings }).querySelector("a.share-instagram")).toBeNull();
  });

  it("og:image is the Flickr lead src; YouTube lead → img.youtube.com/vi/ID/hqdefault.jpg in og:image but no youtube host in any src", () => {
    const flickr = dom({ assetUrl: FLICKR });
    expect(meta(flickr, "og:image")).toBe(FLICKR);
    expect(meta(flickr, "twitter:image")).toBe(FLICKR);
    expect(meta(flickr, "og:type")).toBe("article");
    expect(meta(flickr, "og:title")).toBe("Clinics to open across the province");
    expect(meta(flickr, "og:description")).toBe("Clinics are opening across the province this month.");
    expect(meta(flickr, "og:url")).toBe("https://news.example/releases/2026HLTH0001-000001/");
    // The lead image's alt is the headline, for both cards.
    expect(meta(flickr, "og:image:alt")).toBe("Clinics to open across the province");
    expect(meta(flickr, "twitter:image:alt")).toBe("Clinics to open across the province");

    const html = render({ assetUrl: "https://www.youtube.com/watch?v=abc123DEF" });
    const yt = expectAccessibleStructure(html);
    expect(meta(yt, "og:image")).toBe("https://img.youtube.com/vi/abc123DEF/hqdefault.jpg");
    expect(meta(yt, "twitter:image")).toBe("https://img.youtube.com/vi/abc123DEF/hqdefault.jpg");
    for (const el of yt.querySelectorAll("[src], link[href]")) expect(el.getAttribute("src") ?? el.getAttribute("href")).not.toMatch(/youtube|ytimg/);

    const fallback = "https://news.example/assets/legacy/Content/Images/Gov/default-og-image-new.jpg";
    expect(meta(dom({}), "og:image")).toBe(fallback);
    // The default image carries no page-specific alt.
    expect(meta(dom({}), "og:image:alt")).toBeNull();
    expect(meta(yt, "og:image:alt")).toBe("Clinics to open across the province");
    expect(meta(dom({ assetUrl: "https://news.gov.bc.ca/live" }), "og:image")).toBe(fallback);
    expect(meta(dom({ assetUrl: "javascript:alert(1)" }), "og:image")).toBe(fallback);
  });

  it("lead media div.story-copy.primary-asset first in .story-body; live asset → link to the live webcast", () => {
    const flickr = dom({ assetUrl: FLICKR, documents: [doc({ headline: "Clinics & more", byline: "By A" })] });
    const first = flickr.querySelector(".story-body")!.firstElementChild!;
    expect(first.matches("div.story-copy.primary-asset")).toBe(true);
    const img = first.querySelector("div.asset.flickr > a > img")!;
    expect(img.getAttribute("src")).toBe(FLICKR);
    expect(img.getAttribute("alt")).toBe("Clinics & more");
    expect(first.querySelector("a")?.getAttribute("href")).toBe("https://www.flickr.com/photos/bcgovphotos/53912345678/");

    const yt = dom({ assetUrl: "https://youtu.be/abc123DEF" }).querySelector(".story-body > div.story-copy.primary-asset:first-child div.asset.youtube > a")!;
    expect(yt.getAttribute("href")).toBe("https://www.youtube.com/watch?v=abc123DEF");
    expect(yt.querySelector("img")?.getAttribute("src")).toBe("/assets/legacy/Content/Images/Gov/default-og-image-new.jpg");

    const live = dom({ assetUrl: "https://news.gov.bc.ca/live" }).querySelector(".story-body > div.story-copy.primary-asset:first-child a")!;
    expect(live.getAttribute("href")).toBe("https://news.gov.bc.ca/live");
    expect(live.textContent).toBe("Watch the live webcast");

    for (const assetUrl of [undefined, null, "", "https://evil.example/x.jpg", "javascript:alert(1)"]) {
      expect(dom({ assetUrl }).querySelector(".primary-asset"), String(assetUrl)).toBeNull();
    }
  });

  it("trail: v2 related first (max 3); empty related → ministry latest without this post; neither → no Related Articles", () => {
    const band = (d: Document) => d.querySelector("#main-content + section.media-container[aria-label=Related] > div.story-parts");
    const articles = (d: Document) => [...band(d)!.querySelectorAll(".related-articles > div.related-article")].map((a) => [a.querySelector(":scope > h3 > a")?.textContent, a.querySelector(":scope > h3 > a")?.getAttribute("href"), a.querySelector(":scope > div.item-date")?.textContent]);
    const self = "2026HLTH0001-000001";

    const fromRelated = dom({}, { ...ctx, related: related(4), ministryLatest: latest(["2026HLTH0009-000009"]) });
    expect(band(fromRelated)!.querySelector(".related-articles > h2")?.textContent).toBe("Related Articles");
    expect(articles(fromRelated)).toEqual([
      ["Related 0 <r>", "/releases/2026HLTH0100-000100/", "September 1, 2026"],
      ["Related 1 <r>", "/releases/2026HLTH0100-000101/", "September 2, 2026"],
      ["Related 2 <r>", "/releases/2026HLTH0100-000102/", "September 3, 2026"],
    ]);
    const image = band(fromRelated)!.querySelector(":scope > div.related-image > img")!;
    expect(image.getAttribute("src")).toBe("/assets/legacy/Content/Images/Gov/default-og-meta-image-1.jpg");
    expect(image.getAttribute("alt")).toBe("");

    const fallback = dom({}, { ...ctx, related: [], ministryLatest: latest(["2026HLTH0002-000002", self, "2026HLTH0003-000003", "2026HLTH0004-000004", "2026HLTH0005-000005"]) });
    expect(articles(fallback).map((a) => a[0])).toEqual(["Latest 2026HLTH0002-000002", "Latest 2026HLTH0003-000003", "Latest 2026HLTH0004-000004"]);
    expect(articles(fallback)[0]![2]).toBe("October 1, 2026");

    // Neither related nor a connect block: no band at all.
    const none = dom({}, { ...ctx, leadMinistry: { ...health, flickrUri: null, youtubeUri: null }, related: [], ministryLatest: latest([self]) });
    expect(none.querySelector("section.media-container")).toBeNull();
    expect(none.body.textContent).not.toContain("Related Articles");
    // No articles but a connect block: the band, without Related Articles.
    const connectOnly = dom({}, { ...ctx, related: [], ministryLatest: [] });
    expect(band(connectOnly)).not.toBeNull();
    expect(connectOnly.querySelector(".related-articles")).toBeNull();
    expect(connectOnly.querySelector(".connect-with-bc")).not.toBeNull();
  });

  it("Connect with the Ministry only with a safe Flickr or YouTube URI", () => {
    const connect = (m: Partial<typeof health>) => dom({}, { ...ctx, leadMinistry: { ...health, ...m }, related: related(1) }).querySelector(".story-parts > div.connect-with-bc");
    const both = connect({})!;
    expect(both.querySelector(":scope > h2")?.textContent).toBe("Connect with the Ministry");
    expect([...both.querySelectorAll(":scope > h3 > a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Photos", "https://flickr.example/health"],
      ["Videos", "https://youtube.example/health"],
    ]);
    expect(texts(both, ":scope > p")).toEqual(["View the Ministry's latest photos on Flickr.", "Watch the Ministry's latest videos on YouTube."]);
    const photosOnly = connect({ youtubeUri: "javascript:alert(1)" })!;
    expect(texts(photosOnly, "h3")).toEqual(["Photos"]);
    expect(texts(photosOnly, "p")).toEqual(["View the Ministry's latest photos on Flickr."]);
    expect(texts(connect({ flickrUri: null })!, "h3")).toEqual(["Videos"]);
    expect(connect({ flickrUri: "javascript:alert(1)", youtubeUri: "" })).toBeNull();
    expect(dom({}, { ...noMinistry, related: related(1) }).querySelector(".connect-with-bc")).toBeNull();
  });
});

