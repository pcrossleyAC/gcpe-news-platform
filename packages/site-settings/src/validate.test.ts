import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bcSettings } from "./fixtures";
import { bannerVisibleAt, contrastRatio, defaultSiteSettings, isSafeUrl, validateSiteSettings } from "./index";
import type { SiteSettings } from "./index";

const base = (): SiteSettings => structuredClone(bcSettings());
const errorsFor = (mutate: (d: SiteSettings) => void) => {
  const d = base();
  mutate(d);
  return validateSiteSettings(d);
};

describe("contrastRatio", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21.0, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
    expect(contrastRatio("#013366", "#FFFFFF")).toBeCloseTo(12.6, 1);
    expect(contrastRatio("#CE3E39", "#FFFFFF")).toBeCloseTo(4.8, 1);
  });
});

describe("isSafeUrl", () => {
  it.each(["https://gov.bc.ca", "/contact"])("accepts %s", (u) => expect(isSafeUrl(u)).toBe(true));
  it.each(["http://x.ca", "javascript:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", " https://gov.bc.ca", "gov.bc.ca", ""])(
    "rejects %j",
    (u) => expect(isSafeUrl(u)).toBe(false),
  );
});

describe("validateSiteSettings", () => {
  it("accepts the bc defaults", () => expect(validateSiteSettings(base())).toEqual([]));

  it("rejects an http more-info link", () => {
    expect(errorsFor((d) => { d.footer.moreInfoLinks[2]!.url = "http://www2.gov.bc.ca/privacy"; })).toEqual([
      { field: "footer.moreInfoLinks[2].url", message: "Must start with https:// or / (a page on this site)." },
    ]);
  });

  it("checks the land acknowledgement: 1000 characters at most, plain text, empty allowed", () => {
    expect(errorsFor((d) => { d.footer.landAcknowledgement = "a".repeat(1001); })).toEqual([
      { field: "footer.landAcknowledgement", message: "Keep the land acknowledgement to 1000 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.footer.landAcknowledgement = "a".repeat(1000); })).toEqual([]);
    expect(errorsFor((d) => { d.footer.landAcknowledgement = "<b>hi</b>"; })).toEqual([
      { field: "footer.landAcknowledgement", message: "Use plain text." },
    ]);
    expect(errorsFor((d) => { d.footer.landAcknowledgement = ""; })).toEqual([]);
    expect(errorsFor((d) => { delete d.footer.landAcknowledgement; })).toEqual([]);
    // Trimmed first: whitespace-only is empty (no band), and surrounding whitespace doesn't count
    // toward the limit.
    expect(errorsFor((d) => { d.footer.landAcknowledgement = " \n\t "; })).toEqual([]);
    expect(errorsFor((d) => { d.footer.landAcknowledgement = `  ${"a".repeat(1000)}\n`; })).toEqual([]);
    expect(errorsFor((d) => { d.footer.landAcknowledgement = `  ${"a".repeat(1001)}  `; })).toHaveLength(1);
  });

  it("checks the banner", () => {
    expect(errorsFor((d) => { d.banner.message = "<b>hi</b>"; })).toEqual([
      { field: "banner.message", message: "Use plain text. Add links below instead of HTML." },
    ]);
    expect(errorsFor((d) => { d.banner.enabled = true; d.banner.message = "   "; })).toEqual([
      { field: "banner.message", message: "Enter a message, or turn the banner off." },
    ]);
    expect(errorsFor((d) => { d.banner.message = "a".repeat(301); })).toEqual([
      { field: "banner.message", message: "Keep the message to 300 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.banner.message = "a".repeat(300); })).toEqual([]);
    const ends = { startsAt: "2026-11-01T10:00:00-07:00", endsAt: "2026-11-01T10:00:00-07:00" };
    expect(errorsFor((d) => { Object.assign(d.banner, ends); })).toEqual([
      { field: "banner.endsAt", message: "The end time must be after the start time." },
    ]);
    expect(errorsFor((d) => { d.banner.style = "loud" as never; })).toEqual([
      { field: "banner.style", message: "Choose Information or Emergency." },
    ]);
  });

  it("flags low contrast with the ratio", () => {
    const errors = errorsFor((d) => { d.theme.colors.bannerEmergency = "#F08080"; });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("theme.colors.bannerEmergency");
    expect(errors[0]!.message).toContain("(2.6:1, needs 4.5:1)");
    expect(errors[0]!.message).toBe("Too faint to read behind white text (2.6:1, needs 4.5:1). Pick a darker shade.");
  });

  it("uses the where-wording for each contrast pair", () => {
    expect(errorsFor((d) => { d.theme.colors.text = "#999999"; }).map((e) => e.message.split(" (")[0])).toEqual([
      "Too faint to read on the page background",
      "Too faint to read on panels",
    ]);
    expect(errorsFor((d) => { d.theme.colors.primaryText = "#555555"; })).toEqual([
      { field: "theme.colors.primaryText", message: expect.stringContaining("on the header") },
    ]);
  });

  it("a primary too pale to read as link text on the background is refused", () => {
    expect(errorsFor((d) => { d.theme.colors.primary = "#8FB3E8"; d.theme.colors.primaryText = "#000000"; })).toEqual([
      { field: "theme.colors.primary", message: "Too faint to read as link text (2.1:1, needs 4.5:1). Pick a darker shade." },
      { field: "theme.colors.primary", message: "Too faint to read behind white text (2.1:1, needs 4.5:1). Pick a darker shade." },
    ]);
  });

  // Legacy CSS paints hard-coded white text on the primary colour (custom.css .btn-primary-blue,
  // site.css .news-listing .home-body h3), whatever primaryText and the background are.
  it("a primary too pale behind white text is refused even when links on a dark background read", () => {
    expect(
      errorsFor((d) => {
        Object.assign(d.theme.colors, { primary: "#A0C4FF", primaryText: "#000000", text: "#FFFFFF", background: "#000000", surface: "#000000" });
      }),
    ).toEqual([{ field: "theme.colors.primary", message: "Too faint to read behind white text (1.8:1, needs 4.5:1). Pick a darker shade." }]);
  });

  it("the bc and nb tenant defaults still validate", () => {
    for (const t of ["bc", "nb"]) {
      const tenant = JSON.parse(readFileSync(new URL(`../../../config/tenants/${t}.json`, import.meta.url), "utf8")) as {
        site: { theme: Parameters<typeof defaultSiteSettings>[0] };
      };
      expect(validateSiteSettings(defaultSiteSettings(tenant.site.theme))).toEqual([]);
    }
    expect(validateSiteSettings(bcSettings())).toEqual([]);
  });

  it.each(["013366", "#013", "#01336G", "red"])("rejects the malformed colour %j and skips contrast", (c) => {
    expect(errorsFor((d) => { d.theme.colors.text = c; })).toEqual([{ field: "theme.colors.text", message: "Use a colour like #013366." }]);
  });

  it("checks link summaries and ids", () => {
    expect(errorsFor((d) => { d.connect.x.accounts[0]!.summary = "<script>x</script>"; })).toEqual([
      { field: "connect.x.accounts[0].summary", message: "Use plain text, 200 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.connect.x.featured[0]!.id = 'x" onclick="alert(1)'; })).toEqual([
      { field: "connect.x.featured[0].id", message: "Link id must start with a letter and use only letters, digits, - or _." },
    ]);
  });

  it("checks footer text and link text", () => {
    expect(errorsFor((d) => { d.footer.copyrightHolder = " "; })).toEqual([{ field: "footer.copyrightHolder", message: "Enter who holds the copyright." }]);
    expect(errorsFor((d) => { d.footer.helpText = "a".repeat(201); })).toEqual([
      { field: "footer.helpText", message: "Keep the help text to 200 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.footer.helpText = "<i>"; })).toEqual([{ field: "footer.helpText", message: "Use plain text." }]);
    expect(errorsFor((d) => { d.footer.helpLinks[0]!.text = ""; })).toEqual([{ field: "footer.helpLinks[0].text", message: "Enter the link text." }]);
  });

  it("checks ministry page headings", () => {
    expect(errorsFor((d) => { d.ministryPages.ministryPhotos = "  "; })).toEqual([{ field: "ministryPages.ministryPhotos", message: "Enter a heading." }]);
    const plain = { field: "ministryPages.mediaContacts", message: "Use plain text, 60 characters or fewer." };
    expect(errorsFor((d) => { d.ministryPages.mediaContacts = "a".repeat(61); })).toEqual([plain]);
    expect(errorsFor((d) => { d.ministryPages.mediaContacts = "<b>"; })).toEqual([plain]);
    expect(errorsFor((d) => { d.ministryPages.mediaContacts = "a".repeat(60); })).toEqual([]);
  });
});

describe("bannerVisibleAt", () => {
  const banner = (over: Partial<SiteSettings["banner"]>) => ({ ...base().banner, enabled: true, message: "m", ...over });
  const start = "2026-11-01T10:00:00.000Z";
  const end = "2026-11-02T10:00:00.000Z";
  it("follows the schedule", () => {
    const b = banner({ startsAt: start, endsAt: end });
    expect(bannerVisibleAt(b, new Date(Date.parse(start) - 1000))).toBe(false);
    expect(bannerVisibleAt(b, new Date(start))).toBe(true);
    expect(bannerVisibleAt(b, new Date(end))).toBe(false);
  });
  it("is open-ended without times and hidden when disabled", () => {
    expect(bannerVisibleAt(banner({}), new Date())).toBe(true);
    expect(bannerVisibleAt(banner({ enabled: false }), new Date())).toBe(false);
  });
});

describe("validateSiteSettings — plan-4 parts", () => {
  it("refuses markup in navigation.labels.resources with 'Use plain text.' on that path", () => {
    expect(errorsFor((d) => { d.navigation.labels.resources = "<b>Resources</b>"; })).toEqual([
      { field: "navigation.labels.resources", message: "Use plain text." },
    ]);
  });

  it("plain text everywhere text is expected", () => {
    const cases: [string, (d: SiteSettings) => void][] = [
      ["navigation.newsLabel", (d) => { d.navigation.newsLabel = "a<b"; }],
      ["navigation.footerConnectHeading", (d) => { d.navigation.footerConnectHeading = "x>"; }],
      ["navigation.listingTitles.stories", (d) => { d.navigation.listingTitles.stories = "<i>S</i>"; }],
      ["contactsPage.heading", (d) => { d.contactsPage.heading = "<h1>x</h1>"; }],
      ["contactsPage.lineHeading", (d) => { d.contactsPage.lineHeading = "<x"; }],
      ["contactsPage.listHeading", (d) => { d.contactsPage.listHeading = "<x"; }],
      ["pageText.notFound.heading", (d) => { d.pageText.notFound.heading = "<x"; }],
      ["pageText.notFound.text", (d) => { d.pageText.notFound.text = "<x"; }],
      ["pageText.privacy.label", (d) => { d.pageText.privacy.label = "<x"; }],
      ["pageText.privacy.title", (d) => { d.pageText.privacy.title = "<x"; }],
      ["pageText.live.heading", (d) => { d.pageText.live.heading = "<x"; }],
      ["pageText.collectionNotice.heading", (d) => { d.pageText.collectionNotice.heading = "<x"; }],
      ["pageText.assetLicence.text", (d) => { d.pageText.assetLicence.text = "<x"; }],
      ["pageText.assetLicence.linkText", (d) => { d.pageText.assetLicence.linkText = "<x"; }],
      ["connect.intro", (d) => { d.connect.intro = "<script>"; }],
      ["contactsPage.contacts[0].group", (d) => { d.contactsPage.contacts[0]!.group = "<x"; }],
      ["contactsPage.contacts[0].subgroup", (d) => { d.contactsPage.contacts[0]!.subgroup = "<x"; }],
      ["contactsPage.contacts[0].name", (d) => { d.contactsPage.contacts[0]!.name = "<x"; }],
      ["contactsPage.contacts[0].phone", (d) => { d.contactsPage.contacts[0]!.phone = "<x"; }],
      ["contactsPage.contacts[0].cell", (d) => { d.contactsPage.contacts[0]!.cell = "<x"; }],
    ];
    for (const [field, mutate] of cases) expect(errorsFor(mutate), field).toEqual([{ field, message: "Use plain text." }]);
  });

  it("HTML fields take markup; only their length is checked", () => {
    expect(errorsFor((d) => { d.pageText.privacy.bodyHtml = "<p><strong>x</strong></p>"; })).toEqual([]);
    expect(errorsFor((d) => { d.contactsPage.introHtml = `<p>${"a".repeat(50_000)}</p>`; })).toEqual([
      { field: "contactsPage.introHtml", message: "Keep it to 50000 characters or fewer." },
    ]);
    expect(errorsFor((d) => { d.pageText.subscribeHelpHtml = "a".repeat(50_000); })).toEqual([]);
  });

  it("requires the labels, listing titles, 404 heading, privacy title and directory heading", () => {
    const required = ["navigation.newsLabel", "navigation.liveLabel", "navigation.labels.slideActionLabel", "navigation.listingTitles.updates", "pageText.notFound.heading", "pageText.privacy.title", "contactsPage.heading"];
    const errors = errorsFor((d) => {
      d.navigation.newsLabel = "";
      d.navigation.liveLabel = " ";
      d.navigation.labels.slideActionLabel = "";
      d.navigation.listingTitles.updates = "";
      d.pageText.notFound.heading = "";
      d.pageText.privacy.title = "";
      d.contactsPage.heading = "";
    });
    expect(errors).toEqual(expect.arrayContaining(required.map((field) => ({ field, message: "Enter text for this field." }))));
    expect(errors).toHaveLength(required.length);
    // Optional ones may be empty.
    expect(errorsFor((d) => { d.navigation.footerConnectHeading = ""; d.contactsPage.lineHeading = ""; d.pageText.notFound.text = ""; })).toEqual([]);
  });

  it("caps lengths", () => {
    expect(errorsFor((d) => { d.navigation.labels.highlights = "a".repeat(61); })).toEqual([{ field: "navigation.labels.highlights", message: "Keep it to 60 characters or fewer." }]);
    expect(errorsFor((d) => { d.navigation.labels.highlights = "a".repeat(60); })).toEqual([]);
    expect(errorsFor((d) => { d.navigation.liveLabel = "a".repeat(41); })).toEqual([{ field: "navigation.liveLabel", message: "Keep it to 40 characters or fewer." }]);
    expect(errorsFor((d) => { d.pageText.notFound.text = "a".repeat(301); })).toEqual([{ field: "pageText.notFound.text", message: "Keep it to 300 characters or fewer." }]);
    expect(errorsFor((d) => { d.connect.intro = "a".repeat(301); })).toEqual([{ field: "connect.intro", message: "Keep it to 300 characters or fewer." }]);
    expect(errorsFor((d) => { d.pageText.assetLicence.text = "a".repeat(201); })).toEqual([{ field: "pageText.assetLicence.text", message: "Keep it to 200 characters or fewer." }]);
    expect(errorsFor((d) => { d.pageText.assetLicence.linkText = "a".repeat(101); })).toEqual([{ field: "pageText.assetLicence.linkText", message: "Keep it to 100 characters or fewer." }]);
    expect(errorsFor((d) => { d.contactsPage.contacts[0]!.name = "a".repeat(101); })).toEqual([{ field: "contactsPage.contacts[0].name", message: "Keep it to 100 characters or fewer." }]);
    expect(errorsFor((d) => { d.contactsPage.contacts[0]!.phone = "1".repeat(51); })).toEqual([{ field: "contactsPage.contacts[0].phone", message: "Keep it to 50 characters or fewer." }]);
  });

  it("refuses a 5th headerLink, a 31st directory contact, an 11th archive link", () => {
    const link = { text: "Go", url: "/go/" };
    const contact = { group: "G", groupUrl: "", subgroup: "", name: "N", phone: "", cell: "", email: "", placement: "top" as const };
    expect(errorsFor((d) => { d.navigation.headerLinks = Array(4).fill(link); })).toEqual([]);
    expect(errorsFor((d) => { d.navigation.headerLinks = Array(5).fill(link); })).toEqual([{ field: "navigation.headerLinks", message: "Keep the list to 4 or fewer." }]);
    expect(errorsFor((d) => { d.contactsPage.contacts = Array(30).fill(contact); })).toEqual([]);
    expect(errorsFor((d) => { d.contactsPage.contacts = Array(31).fill(contact); })).toEqual([{ field: "contactsPage.contacts", message: "Keep the list to 30 or fewer." }]);
    expect(errorsFor((d) => { d.pageText.searchArchiveLinks = Array(10).fill(link); })).toEqual([]);
    expect(errorsFor((d) => { d.pageText.searchArchiveLinks = Array(11).fill(link); })).toEqual([{ field: "pageText.searchArchiveLinks", message: "Keep the list to 10 or fewer." }]);
  });

  it("validates the header, archive and LinkedIn links as links", () => {
    expect(errorsFor((d) => { d.navigation.headerLinks[0]!.url = "javascript:alert(1)"; })).toEqual([
      { field: "navigation.headerLinks[0].url", message: "Must start with https:// or / (a page on this site)." },
    ]);
    expect(errorsFor((d) => { d.pageText.searchArchiveLinks[0]!.url = "http://archive.news.gov.bc.ca/"; })).toEqual([
      { field: "pageText.searchArchiveLinks[0].url", message: "Must start with https:// or / (a page on this site)." },
    ]);
    expect(errorsFor((d) => { d.connect.linkedin.accounts[0]!.text = ""; })).toEqual([{ field: "connect.linkedin.accounts[0].text", message: "Enter the link text." }]);
  });

  it("link text is plain text, 200 characters or fewer, in every link list", () => {
    expect(errorsFor((d) => { d.navigation.headerLinks[0]!.text = "<b>Subscribe</b>"; })).toEqual([{ field: "navigation.headerLinks[0].text", message: "Use plain text." }]);
    expect(errorsFor((d) => { d.pageText.searchArchiveLinks[0]!.text = "a>b"; })).toEqual([{ field: "pageText.searchArchiveLinks[0].text", message: "Use plain text." }]);
    expect(errorsFor((d) => { d.connect.linkedin.featured[0]!.text = "a".repeat(201); })).toEqual([{ field: "connect.linkedin.featured[0].text", message: "Keep it to 200 characters or fewer." }]);
    expect(errorsFor((d) => { d.footer.helpLinks[0]!.text = "a".repeat(200); })).toEqual([]);
  });

  it("refuses contactsPage.contacts[0].email 'x@' and groupUrl 'javascript:alert(1)'; accepts '' for both", () => {
    expect(errorsFor((d) => { d.contactsPage.contacts[0]!.email = "x@"; d.contactsPage.contacts[0]!.groupUrl = "javascript:alert(1)"; })).toEqual([
      { field: "contactsPage.contacts[0].groupUrl", message: "Must start with https:// or / (a page on this site)." },
      { field: "contactsPage.contacts[0].email", message: "Enter an email address like name@gov.bc.ca." },
    ]);
    expect(errorsFor((d) => { d.contactsPage.contacts[0]!.email = "<a@b.ca>"; })).toEqual([
      { field: "contactsPage.contacts[0].email", message: "Enter an email address like name@gov.bc.ca." },
    ]);
    expect(errorsFor((d) => { d.contactsPage.contacts[0]!.email = ""; d.contactsPage.contacts[0]!.groupUrl = ""; })).toEqual([]);
    expect(errorsFor((d) => { d.contactsPage.contacts[0]!.email = "name@gov.bc.ca"; d.contactsPage.contacts[0]!.groupUrl = "https://gov.bc.ca/x"; })).toEqual([]);
  });

  it("requires a directory contact's group and name", () => {
    expect(errorsFor((d) => { d.contactsPage.contacts[0]!.group = ""; d.contactsPage.contacts[0]!.name = " "; })).toEqual([
      { field: "contactsPage.contacts[0].group", message: "Enter text for this field." },
      { field: "contactsPage.contacts[0].name", message: "Enter text for this field." },
    ]);
  });

  it("assetLicence: url without text is refused; all three empty is accepted", () => {
    expect(errorsFor((d) => { d.pageText.assetLicence = { text: "", linkText: "", url: "https://x.ca/l.pdf" }; })).toEqual([
      { field: "pageText.assetLicence.linkText", message: "Enter the link text." },
    ]);
    expect(errorsFor((d) => { d.pageText.assetLicence = { text: "Terms", linkText: "", url: "" }; })).toEqual([
      { field: "pageText.assetLicence.linkText", message: "Enter the link text." },
      { field: "pageText.assetLicence.url", message: "Must start with https:// or / (a page on this site)." },
    ]);
    expect(errorsFor((d) => { d.pageText.assetLicence = { text: "", linkText: "", url: "" }; })).toEqual([]);
  });

  it("connect.policyLink with an http:// url is refused; both empty is accepted", () => {
    expect(errorsFor((d) => { d.connect.policyLink.url = "http://news.gov.bc.ca/x"; })).toEqual([
      { field: "connect.policyLink.url", message: "Must start with https:// or / (a page on this site)." },
    ]);
    expect(errorsFor((d) => { d.connect.policyLink = { text: "", url: "/policy/" }; })).toEqual([{ field: "connect.policyLink.text", message: "Enter the link text." }]);
    expect(errorsFor((d) => { d.connect.policyLink = { text: "", url: "" }; })).toEqual([]);
  });
});
