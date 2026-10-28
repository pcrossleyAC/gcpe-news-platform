import { describe, expect, it } from "vitest";
import { expectAccessibleStructure, withoutBannerScript } from "../../test/structure";
import { bcSettings, category, contact, ministry, post, site } from "../../test/fixtures";
import { renderCategoryPage, renderMinistriesPage, renderMinistryPage } from "./categories";

const emptyPosts = { top: null, feature: null, latest: [] };

describe("renderMinistriesPage", () => {
  it("is accessible, with h1 'Ministries'", () => {
    const doc = expectAccessibleStructure(renderMinistriesPage([], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("Ministries");
  });

  it("lists only active ministries, in the API's order, each linking to /ministries/<key>/ with its minister's name", () => {
    const ministries = [
      ministry({ key: "health", name: "Health", ministerName: "Minister Alex Example" }),
      ministry({ key: "education", name: "Education", isActive: false }),
      ministry({ key: "finance", name: "Finance", ministerName: "Minister Jordan Example" }),
    ];
    const doc = expectAccessibleStructure(renderMinistriesPage(ministries, site, {}));
    const links = [...doc.querySelectorAll("main a")].filter((a) => a.getAttribute("href")?.startsWith("/ministries/"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/ministries/health/", "/ministries/finance/"]);
    expect(links[0]?.textContent).toBe("Health");
    expect(doc.querySelector('a[href="/ministries/health/"]')?.parentElement?.textContent).toContain("Minister Alex Example");
    expect(doc.body.textContent).not.toContain("Education");
  });

  it("leaves out a ministry whose key fails categoryPageId", () => {
    const ministries = [ministry({ key: "../etc", name: "Hostile" })];
    const doc = expectAccessibleStructure(renderMinistriesPage(ministries, site, {}));
    expect(doc.body.textContent).not.toContain("Hostile");
  });

  it("escapes a ministry name", () => {
    const html = renderMinistriesPage([ministry({ name: "A & <B>" })], site, {});
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).not.toContain("A & <B>");
  });
});

describe("renderMinistryPage", () => {
  it("is accessible, with the ministry name as h1", () => {
    const doc = expectAccessibleStructure(renderMinistryPage(ministry({}), null, emptyPosts, site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("Health");
  });

  it("shows the minister's summary escaped, their details sanitised and demoted, and the photo alt as the minister's name", () => {
    const minister = { headline: "Minister of Health", summary: "Alex <leads> the ministry.", details: "<h1>Biography</h1><p>Served since 2020.</p>", photo: "https://files.example/files/minister.jpg" };
    const doc = expectAccessibleStructure(renderMinistryPage(ministry({ ministerName: "Minister Alex Example" }), minister, emptyPosts, site, {}));
    const html = doc.documentElement.outerHTML;
    expect(html).toContain("Alex &lt;leads&gt; the ministry.");
    expect(html).toContain("<p>Served since 2020.</p>");
    expect(doc.querySelectorAll("h1")).toHaveLength(1); // the demoted body h1 doesn't create a second one
    expect(doc.querySelector("img")?.getAttribute("alt")).toBe("Minister Alex Example");
  });

  it("sanitises the minister's details (C209)", () => {
    const minister = { headline: "H", summary: null, details: '<p>Safe.</p><script>alert(1)</script><a href="javascript:alert(1)">Click</a>', photo: null };
    const html = withoutBannerScript(renderMinistryPage(ministry({}), minister, emptyPosts, site, {}));
    expect(html).toContain("<p>Safe.</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Click");
  });

  it("links the ministry URL, lists top/feature/latest posts, and links the archive and ministry search", () => {
    const top = post({ key: "T1" });
    const feature = post({ key: "F1" });
    const latest = [post({ key: "L1" })];
    const doc = expectAccessibleStructure(renderMinistryPage(ministry({ key: "health", name: "Health", ministryUrl: "https://gov.example/health" }), null, { top, feature, latest }, site, {}));
    expect(doc.querySelector('a[href="https://gov.example/health"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/releases/T1/"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/releases/F1/"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/releases/L1/"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/archive/"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/search/?ministry=health"]')).not.toBeNull();
  });

  it("refuses a javascript: ministry URL and a javascript: minister photo", () => {
    const minister = { headline: "H", summary: null, details: null, photo: "javascript:alert(1)" };
    const html = renderMinistryPage(ministry({ ministryUrl: "javascript:alert(1)" }), minister, emptyPosts, site, {});
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="javascript:');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Ministry Website");
    expect(html).not.toContain("<aside");
  });

  it("links the feed alternate at /ministries/<key>/feed.xml", () => {
    const html = renderMinistryPage(ministry({ key: "health" }), null, emptyPosts, site, {});
    expect(html).toContain('href="/ministries/health/feed.xml"');
  });

  // boxs.ca: the v1 Ministries list carries contacts as Core's contact record
  // ({fullName, phoneNumber, mobileNumber, emailAddress}); a {name,title,phone,email} reader
  // rendered nothing. Legacy (Views/Shared/Ministry.cshtml + CommContact.cshtml): name, then
  // "Direct: <phone>", "Cell: <mobile>", a mailto link; "Alternate:" before the second contact;
  // "After hours: <number>" last; the whole section only when the first contact exists.
  it("shows media contacts as legacy does: name, Direct:, Cell:, mailto email, Alternate:, After hours:", () => {
    const doc = expectAccessibleStructure(
      renderMinistryPage(
        ministry({
          contactUser: contact({ fullName: "Alex <Example>", phoneNumber: "250-555-0100", mobileNumber: "250-555-0101", emailAddress: "alex@example.test" }),
          secondContactUser: contact({ fullName: "Jordan Example", phoneNumber: "250-555-0200", mobileNumber: null, emailAddress: "jordan@example.test" }),
          weekendContactNumber: "250-555-0199",
        }),
        null,
        emptyPosts,
        site,
        {},
      ),
    );
    const section = [...doc.querySelectorAll("aside section")].find((s) => s.querySelector("h2")?.textContent === "Media Contacts");
    expect(section).toBeDefined();
    const items = [...section!.querySelectorAll("li")];
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector(".contact-name")?.textContent).toBe("Alex <Example>");
    expect(items[0]!.textContent).toContain("Direct: 250-555-0100");
    expect(items[0]!.textContent).toContain("Cell: 250-555-0101");
    expect(items[0]!.querySelector("a")?.getAttribute("href")).toBe("mailto:alex@example.test");
    expect(items[0]!.querySelector("a")?.textContent).toBe("alex@example.test");
    expect(items[1]!.textContent).toMatch(/^\s*Alternate:/);
    expect(items[1]!.querySelector(".contact-name")?.textContent).toBe("Jordan Example");
    expect(items[1]!.textContent).toContain("Direct: 250-555-0200");
    expect(items[1]!.textContent).not.toContain("Cell:");
    expect(items[1]!.querySelector("a")?.getAttribute("href")).toBe("mailto:jordan@example.test");
    expect(section!.textContent).toContain("After hours: 250-555-0199");
    const order = section!.textContent!;
    expect(order.indexOf("Alex")).toBeLessThan(order.indexOf("Alternate:"));
    expect(order.indexOf("Alternate:")).toBeLessThan(order.indexOf("After hours:"));
  });

  it("escapes every contact value, including inside the mailto link", () => {
    const html = withoutBannerScript(
      renderMinistryPage(
        ministry({ contactUser: contact({ fullName: "A <b>", phoneNumber: "<i>1</i>", mobileNumber: null, emailAddress: 'x"><script>alert(1)</script>@example.test' }), weekendContactNumber: "<u>9</u>" }),
        null,
        emptyPosts,
        site,
        {},
      ),
    );
    expect(html).toContain("A &lt;b&gt;");
    expect(html).toContain("Direct: &lt;i&gt;1&lt;/i&gt;");
    expect(html).toContain('href="mailto:x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@example.test"');
    expect(html).toContain("After hours: &lt;u&gt;9&lt;/u&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("a contact with only some fields shows just those; no first contact means no section (legacy)", () => {
    const nameOnly = renderMinistryPage(ministry({ contactUser: contact({ fullName: "Alex Example" }) }), null, emptyPosts, site, {});
    expect(nameOnly).toContain("Media Contacts");
    expect(nameOnly).toContain("Alex Example");
    expect(nameOnly).not.toContain("Direct:");
    expect(nameOnly).not.toContain("mailto:");

    const without = renderMinistryPage(ministry({ contactUser: null, secondContactUser: contact({ fullName: "Jordan Example" }), weekendContactNumber: "250-555-0199" }), null, emptyPosts, site, {});
    expect(without).not.toContain("Media Contacts");
    const allNull = renderMinistryPage(ministry({ contactUser: contact({}) }), null, emptyPosts, site, {});
    expect(allNull).not.toContain("Media Contacts");
  });
});

describe("renderMinistryPage side column", () => {
  const settings = bcSettings();
  const full = () =>
    ministry({
      ministryUrl: "https://gov.example/health",
      flickrUri: "https://flickr.com/health",
      youtubeUri: "https://youtube.com/health",
      contactUser: contact({ fullName: "Alex Example", phoneNumber: "250-555-0100", emailAddress: "alex@example.test" }),
      topicLinks: [{ key: "Wait times", uri: "https://gov.example/wait" }],
      serviceLinks: [{ key: "Find a doctor", uri: "https://gov.example/doctor" }],
    });
  const render = (m: ReturnType<typeof ministry>, s = settings) => expectAccessibleStructure(renderMinistryPage(m, null, emptyPosts, site, { settings: s }));

  it("puts Media Contacts, More from this Ministry, Featured Topics, Featured Services in an aside, in order", () => {
    const doc = render(full());
    const aside = doc.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.getAttribute("aria-label") || aside?.getAttribute("aria-labelledby")).toBeTruthy();
    expect([...aside!.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Media Contacts", "More from this Ministry", "Featured Topics", "Featured Services"]);
    expect([...aside!.querySelectorAll("section:nth-of-type(2) a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Ministry Website", "https://gov.example/health"],
      ["Ministry Photos", "https://flickr.com/health"],
      ["Ministry Videos", "https://youtube.com/health"],
    ]);
    expect(aside!.querySelector('a[href="https://gov.example/wait"]')?.textContent).toBe("Wait times");
    expect(aside!.querySelector('a[href="https://gov.example/doctor"]')?.textContent).toBe("Find a doctor");
    expect(doc.querySelector("main > a[href='https://gov.example/health']")).toBeNull();
    expect(doc.querySelectorAll("main > h1, main h1")).toHaveLength(1);
  });

  it("uses the settings' headings and link labels", () => {
    const renamed = { ...settings, ministryPages: { ...settings.ministryPages, mediaContacts: "Press <Office>", moreFromMinistry: "Around Health", ministryWebsite: "Home site", featuredTopics: "Topics", featuredServices: "Services" } };
    const doc = render(full(), renamed);
    expect([...doc.querySelectorAll("aside h2")].map((h) => h.textContent)).toEqual(["Press <Office>", "Around Health", "Topics", "Services"]);
    expect(doc.querySelector('aside a[href="https://gov.example/health"]')?.textContent).toBe("Home site");
  });

  it("omits empty groups, and each unset More link", () => {
    const doc = render(ministry({ ministryUrl: null, flickrUri: "https://flickr.com/health", topicLinks: [{ key: "T", uri: "https://gov.example/t" }] }));
    expect([...doc.querySelectorAll("aside h2")].map((h) => h.textContent)).toEqual(["More from this Ministry", "Featured Topics"]);
    expect([...doc.querySelectorAll("aside a")].map((a) => a.textContent)).toEqual(["Ministry Photos", "T"]);
  });

  it("has no aside when every group is empty", () => {
    const doc = render(ministry({ ministryUrl: null }));
    expect(doc.querySelector("aside")).toBeNull();
  });

  it("keeps http: and https: links, resolves site-relative ones under the base path, drops javascript:/data: and escapes text", () => {
    const html = renderMinistryPage(
      ministry({
        ministryUrl: "http://gov.bc.ca/health",
        flickrUri: "javascript:alert(1)",
        youtubeUri: "data:text/html,x",
        topicLinks: [{ key: "<b>Bad</b>", uri: "javascript:alert(2)" }, { key: "A & <B>", uri: "http://gov.example/ok" }, { key: "Local", uri: "/subscribe" }],
        serviceLinks: [{ key: "Evil", uri: "data:text/html,y" }],
      }),
      null,
      emptyPosts,
      { ...site, baseUrl: "https://boxs.example/site" },
      { settings },
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("<b>Bad");
    expect(html).not.toContain("Featured Services");
    expect(html).not.toContain("Ministry Photos");
    expect(html).not.toContain("Ministry Videos");
    expect(html).toContain('href="http://gov.bc.ca/health"');
    expect(html).toContain('href="http://gov.example/ok">A &amp; &lt;B&gt;');
    expect(html).toContain('href="/site/subscribe">Local');
  });
});

describe("renderCategoryPage", () => {
  it("is accessible, with the category name as h1", () => {
    const doc = expectAccessibleStructure(renderCategoryPage("sectors", category({ name: "Economy" }), emptyPosts, site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("Economy");
  });

  it("sectors: lists latest posts and links the archive and a sector search", () => {
    const latest = [post({ key: "L1" })];
    const doc = expectAccessibleStructure(renderCategoryPage("sectors", category({ key: "economy", name: "Economy" }), { ...emptyPosts, latest }, site, {}));
    expect(doc.querySelector('a[href="/releases/L1/"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/archive/"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/search/?sector=economy"]')).not.toBeNull();
  });

  it("tags: links the archive but has no search link", () => {
    const doc = expectAccessibleStructure(renderCategoryPage("tags", category({ key: "covid-19", name: "COVID-19", kind: "tags" }), emptyPosts, site, {}));
    expect(doc.querySelector('a[href="/archive/"]')).not.toBeNull();
    expect(doc.querySelector('main a[href^="/search/"]')).toBeNull();
  });

  it("escapes the category name", () => {
    const html = renderCategoryPage("sectors", category({ name: "A & <B>" }), emptyPosts, site, {});
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).not.toContain("A & <B>");
  });
});
