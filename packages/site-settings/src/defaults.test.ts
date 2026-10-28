import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bcSettings, prePlan4Settings } from "./fixtures";
import {
  connectDisplayOrder, defaultSiteSettings, DEFAULT_NAVIGATION, fillMissingFields, siteSettingsSchema, storedSiteSettingsSchema, validateSiteSettings,
} from "./index";
import { NETWORKS } from "./index";
import { loadSiteSettingsDefaults } from "./node";

const bc = JSON.parse(readFileSync(new URL("../../../config/tenants/bc.json", import.meta.url), "utf8")) as {
  site: { theme: { colors: Parameters<typeof defaultSiteSettings>[0]["colors"]; footerLinks: { label: string; url: string }[] } };
};

describe("derived defaults", () => {
  const doc = defaultSiteSettings(bc.site.theme);
  it("validate and follow the spec", () => {
    expect(validateSiteSettings(doc)).toEqual([]);
    expect(doc.banner.enabled).toBe(false);
    expect(doc.theme.colors.bannerInfo).toBe("#013366");
    expect(doc.theme.colors.bannerEmergency).toBe("#D8292F");
    expect(doc.footer.moreInfoLinks.map((l) => l.text)).toEqual(bc.site.theme.footerLinks.map((l) => l.label));
    expect(doc.footer.helpLinks).toEqual([]);
    expect(doc.footer.landAcknowledgement).toBe("");
    expect(NETWORKS.every(({ key }) => doc.connect[key].featured.length === 0 && doc.connect[key].accounts.length === 0)).toBe(true);
  });
  it("carries the seven news.gov ministry headings", () => {
    expect(doc.ministryPages).toEqual({
      moreFromMinistry: "More from this Ministry",
      ministryWebsite: "Ministry Website",
      ministryPhotos: "Ministry Photos",
      ministryVideos: "Ministry Videos",
      featuredTopics: "Featured Topics",
      featuredServices: "Featured Services",
      mediaContacts: "Media Contacts",
    });
  });
  it("derives a fresh document each call", () => {
    expect(defaultSiteSettings(bc.site.theme)).not.toBe(doc);
    expect(defaultSiteSettings(bc.site.theme).ministryPages).not.toBe(doc.ministryPages);
  });
});

describe("bc.site-settings.json", () => {
  const raw = bcSettings();
  it("validates and matches the news.gov defaults", () => {
    expect(validateSiteSettings(raw)).toEqual([]);
    expect(raw.banner.enabled).toBe(false);
    expect(raw.footer.moreInfoLinks.map((l) => l.id)).toEqual([
      "footerHome", "footerDisclaimer", "footerPrivacy", "footerAccessibility", "footerCopyright", "footerContact",
    ]);
    expect(raw.footer.copyrightHolder).toBe("Government of British Columbia");
    expect(NETWORKS.reduce((n, { key }) => n + raw.connect[key].featured.length + raw.connect[key].accounts.length, 0)).toBe(88);
    expect(connectDisplayOrder(raw.connect.x)[0]!.text).toBe("@BCGovNews");
  });
  it("is returned as given by defaultSiteSettings", () => {
    expect(defaultSiteSettings(bc.site.theme, raw)).toEqual(raw);
  });
  it("throws when the tenant file does not parse or validate", () => {
    expect(() => defaultSiteSettings(bc.site.theme, { schemaVersion: 1 })).toThrow();
    const bad = structuredClone(raw);
    bad.footer.copyrightHolder = "";
    expect(() => defaultSiteSettings(bc.site.theme, bad)).toThrow(/copyrightHolder/);
  });
  it("bc defaults carry the legacy land acknowledgement text verbatim", () => {
    expect(raw.footer.landAcknowledgement).toBe(
      'The B.C. Public Service acknowledges the territories of First Nations around B.C. and is grateful to carry out our work on these lands. We acknowledge the rights, interests, priorities, and concerns of all Indigenous Peoples - First Nations, Métis, and Inuit - respecting and acknowledging their distinct cultures, histories, rights, laws, and governments.',
    );
  });
});

describe("land acknowledgement on documents that predate it", () => {
  const raw = bcSettings();
  const legacy = () => {
    const d = structuredClone(raw);
    delete d.footer.landAcknowledgement;
    return d;
  };
  it("a document without footer.landAcknowledgement parses and validates", () => {
    const d = legacy();
    expect("landAcknowledgement" in d.footer).toBe(false);
    expect(siteSettingsSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(validateSiteSettings(d)).toEqual([]);
  });
  it("fillMissingFields takes the default only when the field is absent; an explicit \"\" is kept", () => {
    const filled = fillMissingFields(legacy(), raw);
    expect(filled.footer.landAcknowledgement).toBe(raw.footer.landAcknowledgement);
    const blank = structuredClone(raw);
    blank.footer.landAcknowledgement = "";
    expect(fillMissingFields(blank, raw).footer.landAcknowledgement).toBe("");
    const own = structuredClone(raw);
    own.footer.landAcknowledgement = "Ours.";
    expect(fillMissingFields(own, raw).footer.landAcknowledgement).toBe("Ours.");
  });
  it("returns a new document and leaves its inputs alone", () => {
    const d = legacy();
    const out = fillMissingFields(d, raw);
    expect(out).not.toBe(d);
    expect("landAcknowledgement" in d.footer).toBe(false);
  });
});

describe("plan-4 parts (contactsPage, pageText, navigation, connect.linkedin/policyLink/intro)", () => {
  const raw = bcSettings();
  const prePlan4 = prePlan4Settings;

  it("a pre-plan-4 document parses as stored but not as complete", () => {
    const json = JSON.parse(JSON.stringify(prePlan4()));
    expect(storedSiteSettingsSchema.parse(json)).toEqual(prePlan4());
    expect(siteSettingsSchema.safeParse(json).success).toBe(false);
  });

  it("fillMissingFields fills contactsPage, pageText, navigation, connect.linkedin/policyLink/intro from defaults and keeps a stored value, including ''", () => {
    const filled = fillMissingFields(prePlan4(), raw);
    expect(filled).toEqual(raw);
    expect(siteSettingsSchema.parse(filled)).toEqual(raw);
    expect(validateSiteSettings(filled)).toEqual([]);
    // Nothing in the result is shared with the defaults (an edit to one can't leak into the other).
    expect(filled.navigation).not.toBe(raw.navigation);
    expect(filled.connect.linkedin).not.toBe(raw.connect.linkedin);

    const own = prePlan4();
    own.connect.intro = "";
    own.connect.policyLink = { text: "", url: "" };
    own.connect.linkedin = { featured: [], accounts: [] };
    own.navigation = { ...raw.navigation, newsLabel: "Nouvelles" };
    own.pageText = { ...raw.pageText, subscribeHelpHtml: "" };
    own.contactsPage = { ...raw.contactsPage, contacts: [] };
    const kept = fillMissingFields(own, raw);
    expect(kept.connect.intro).toBe("");
    expect(kept.connect.policyLink).toEqual({ text: "", url: "" });
    expect(kept.connect.linkedin).toEqual({ featured: [], accounts: [] });
    expect(kept.navigation.newsLabel).toBe("Nouvelles");
    expect(kept.pageText.subscribeHelpHtml).toBe("");
    expect(kept.contactsPage.contacts).toEqual([]);
    expect(kept.pageText.notFound).toEqual(raw.pageText.notFound);
  });

  it("fillMissingFields leaves its input alone", () => {
    const d = prePlan4();
    fillMissingFields(d, raw);
    expect(d).toEqual(prePlan4());
  });

  it("bc.site-settings.json loads (loadSiteSettingsDefaults) and validates; contactsPage.contacts has role-level rows only (P4-R2/R3): the legacy Office of the Premier row, at the bottom", () => {
    const bcConfig = fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url));
    const loaded = loadSiteSettingsDefaults(bcConfig, bc.site.theme);
    expect(loaded).toEqual(raw);
    expect(validateSiteSettings(loaded)).toEqual([]);
    const placements = loaded.contactsPage.contacts.map((c) => c.placement);
    expect(placements).toEqual(["bottom"]);
    // P4-R2: no named staff and no personal cell numbers in the public repo; P4-R3: no personal
    // name on the Premier row either (it goes stale at the next election).
    expect(loaded.contactsPage.contacts.every((c) => c.cell === "")).toBe(true);
    expect(JSON.stringify(loaded)).not.toMatch(/Catherine|Haroon|Eby|778-686-7925|604-312-6470/);
    expect(loaded.contactsPage.contacts).toEqual([
      { group: "Office of the Premier", groupUrl: "/ministries/office-of-the-premier/", subgroup: "Premier", name: "Media Line", phone: "", cell: "", email: "Premier.Media@gov.bc.ca", placement: "bottom" },
    ]);
  });

  it("bc defaults carry the legacy text verbatim", () => {
    expect(raw.contactsPage.heading).toBe("Government Communications and Public Engagement");
    expect(raw.contactsPage.lineHeading).toBe("24 hours Media Relations Contact Line");
    expect(raw.contactsPage.listHeading).toBe("Contact List for Media");
    expect(raw.contactsPage.introHtml).toContain("call media relations at 250-883-2951.");
    expect(raw.contactsPage.introHtml).not.toContain("target");
    expect(raw.pageText.notFound).toEqual({
      heading: "That web page doesn't exist.",
      text: "The URL may be misspelled or the page you're looking for is no longer available. Search for it below.",
    });
    expect(raw.pageText.privacy.title).toBe("B.C. Government Website Privacy Statement");
    expect(raw.pageText.privacy.bodyHtml.startsWith("<p><strong>Introduction</strong></p>")).toBe(true);
    expect(raw.pageText.privacy.bodyHtml).toContain("telephone (250) 356-1851.");
    expect(raw.pageText.privacy.bodyHtml).not.toMatch(/Reset Preferences|media-asset-preferences/);
    expect(raw.pageText.collectionNotice.bodyHtml).toContain('<a href="tel:2503871337">250 387-1337</a>');
    expect(raw.pageText.assetLicence).toEqual({
      text: "These assets are subject to the terms of the",
      linkText: "News Footage License - British Columbia",
      url: "https://news.gov.bc.ca/files/News_Footage_License_British_Columbia.pdf",
    });
    expect(raw.pageText.searchArchiveLinks.map((l) => l.url)).toEqual([
      "https://archive.news.gov.bc.ca/Default.aspx?archive=2009-2013",
      "https://archive.news.gov.bc.ca/archive/2005-2009/",
      "https://archive.news.gov.bc.ca/archive/2001-2005/",
      "https://archive.news.gov.bc.ca/archive/pre2001/default.htm",
    ]);
    expect(raw.navigation).toEqual(DEFAULT_NAVIGATION);
    expect(raw.navigation.listingTitles.factsheets).toBe("Factsheets & Opinion Editorials");
    expect(connectDisplayOrder(raw.connect.linkedin).map((l) => l.text)).toEqual([
      "Government of BC", "BC Public Service", "British Columbia Geological Survey", "Trade & Invest BC", "WorkBC",
    ]);
    expect(raw.connect.policyLink).toEqual({
      text: "BC Government News Social Media policy, collection notice and hours of operation",
      url: "https://news.gov.bc.ca/stories/bc-government-news-social-media-moderation-policy-hours-of-operation-and-collection-notice",
    });
    expect(raw.connect.intro).toBe("");
  });

  it("neutral defaults validate", () => {
    const neutral = defaultSiteSettings(bc.site.theme);
    expect(validateSiteSettings(neutral)).toEqual([]);
    expect(neutral.contactsPage).toEqual({ heading: "Media contacts", lineHeading: "", introHtml: "", listHeading: "Contacts", contacts: [] });
    expect(neutral.pageText.notFound).toEqual({ heading: "Page not found", text: "The page you asked for isn't here. It may have moved or been removed." });
    expect(neutral.pageText.privacy).toEqual({ label: "Privacy", title: "Privacy", bodyHtml: "" });
    expect(neutral.pageText.assetLicence).toEqual({ text: "", linkText: "", url: "" });
    expect(neutral.navigation).toEqual(DEFAULT_NAVIGATION);
    expect(neutral.connect.linkedin).toEqual({ featured: [], accounts: [] });
    expect(neutral.connect.policyLink).toEqual({ text: "", url: "" });
    expect(neutral.connect.intro).toBe("");
  });

  it("a tenant file without the plan-4 parts loads, filled from the theme-derived defaults", () => {
    const loaded = defaultSiteSettings(bc.site.theme, JSON.parse(JSON.stringify(prePlan4())));
    expect(loaded.navigation).toEqual(DEFAULT_NAVIGATION);
    expect(loaded.contactsPage.heading).toBe("Media contacts");
    expect(loaded.connect.linkedin).toEqual({ featured: [], accounts: [] });
    expect(loaded.footer).toEqual(raw.footer);
  });
});
