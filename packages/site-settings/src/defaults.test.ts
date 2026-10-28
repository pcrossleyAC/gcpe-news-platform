import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bcSettings } from "./fixtures";
import { connectDisplayOrder, defaultSiteSettings, fillMissingFields, siteSettingsSchema, validateSiteSettings } from "./index";
import { NETWORKS } from "./index";

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
    expect(Object.values(doc.connect).every((n) => n.featured.length === 0 && n.accounts.length === 0)).toBe(true);
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
    expect(NETWORKS.reduce((n, { key }) => n + raw.connect[key].featured.length + raw.connect[key].accounts.length, 0)).toBe(83);
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
