import { siteSettingsSchema } from "./model";
import type { MinistryPageLabels, SiteSettings, ThemeColors } from "./model";
import { validateSiteSettings } from "./validate";

export const DEFAULT_MINISTRY_PAGES: MinistryPageLabels = {
  moreFromMinistry: "More from this Ministry",
  ministryWebsite: "Ministry Website",
  ministryPhotos: "Ministry Photos",
  ministryVideos: "Ministry Videos",
  featuredTopics: "Featured Topics",
  featuredServices: "Featured Services",
  mediaContacts: "Media Contacts",
};

const emptyNetwork = () => ({ featured: [], accounts: [] });

/** What the site shows before anything is published: the tenant's own settings file when it has
 * one (parsed and validated; throws if it isn't a valid document), else defaults derived from
 * its theme. */
export function defaultSiteSettings(
  tenantTheme: {
    colors: Omit<ThemeColors, "bannerInfo" | "bannerEmergency">;
    footerLinks: { label: string; url: string }[];
  },
  tenantDefaults?: unknown,
): SiteSettings {
  const doc: SiteSettings =
    tenantDefaults !== undefined
      ? siteSettingsSchema.parse(tenantDefaults)
      : {
          schemaVersion: 1,
          banner: { enabled: false, style: "info", message: "", links: [], dismissible: true, startsAt: null, endsAt: null },
          theme: { colors: { ...tenantTheme.colors, bannerInfo: "#013366", bannerEmergency: "#D8292F" } },
          footer: {
            helpText: "",
            helpLinks: [],
            connectLinks: [],
            moreInfoLinks: tenantTheme.footerLinks.map((l) => ({ text: l.label, url: l.url })),
            copyrightHolder: "Government of British Columbia",
            landAcknowledgement: "",
          },
          connect: {
            facebook: emptyNetwork(),
            x: emptyNetwork(),
            instagram: emptyNetwork(),
            threads: emptyNetwork(),
            bluesky: emptyNetwork(),
            flickr: emptyNetwork(),
            youtube: emptyNetwork(),
            blogs: emptyNetwork(),
          },
          ministryPages: { ...DEFAULT_MINISTRY_PAGES },
        };
  const errors = validateSiteSettings(doc);
  if (errors.length > 0) {
    throw new Error(`Default site settings are invalid: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
  }
  return doc;
}

/**
 * `doc` with every optional field it lacks taken from `defaults` (a new document; neither input
 * is changed). A document published before a field existed has no value for it; an explicit
 * value, including "", is the editor's choice and is kept. The single place a later optional
 * field gets its default.
 */
export function fillMissingFields(doc: SiteSettings, defaults: SiteSettings): SiteSettings {
  return { ...doc, footer: { ...doc.footer, landAcknowledgement: doc.footer.landAcknowledgement ?? defaults.footer.landAcknowledgement } };
}
