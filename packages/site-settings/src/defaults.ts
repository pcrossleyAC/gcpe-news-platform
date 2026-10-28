import { storedSiteSettingsSchema } from "./model";
import type { ContactsPageSettings, MinistryPageLabels, NavigationSettings, PageTextSettings, SiteSettings, StoredSiteSettings, ThemeColors } from "./model";
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

/** The news.gov navigation and labels: nothing in them is BC-specific, so every tenant starts here. */
export const DEFAULT_NAVIGATION: NavigationSettings = {
  newsLabel: "News",
  liveLabel: "Live Webcast",
  headerLinks: [{ text: "Subscribe", url: "/subscribe/" }],
  showHeaderSearch: true,
  footerConnectHeading: "Connect with Us",
  footerMoreInfoHeading: "More Info",
  labels: {
    connectWithUs: "Connect With Us",
    viewAllSocialMedia: "View all Social Media",
    resources: "Resources",
    newsBySector: "News by Sector",
    emergencyInformation: "Emergency information",
    highlights: "Highlights",
    latestNews: "Latest news",
    loadMoreNews: "Load More News",
    searchNews: "Search News",
    browseMoreNews: "Browse More News",
    slideActionLabel: "Learn more",
  },
  listingTitles: { releases: "Releases", stories: "Stories", factsheets: "Factsheets & Opinion Editorials", updates: "Updates" },
};

const neutralContactsPage = (): ContactsPageSettings => ({ heading: "Media contacts", lineHeading: "", introHtml: "", listHeading: "Contacts", contacts: [] });

const neutralPageText = (): PageTextSettings => ({
  notFound: { heading: "Page not found", text: "The page you asked for isn't here. It may have moved or been removed." },
  privacy: { label: "Privacy", title: "Privacy", bodyHtml: "" },
  live: { heading: "Live", consentHtml: "", offAirHtml: "" },
  collectionNotice: { heading: "Notice of Collection", bodyHtml: "" },
  subscribeHelpHtml: "",
  assetLicence: { text: "", linkText: "", url: "" },
  searchArchiveLinks: [],
});

const emptyNetwork = () => ({ featured: [], accounts: [] });

/** The defaults derived from a tenant theme alone (no tenant settings file). */
function neutralDefaults(tenantTheme: Parameters<typeof defaultSiteSettings>[0]): SiteSettings {
  return {
    schemaVersion: 1,
    banner: { enabled: false, style: "info", message: "", links: [], dismissible: true, startsAt: null, endsAt: null },
    theme: { colors: { ...tenantTheme.colors, bannerInfo: "#013366", bannerEmergency: "#D8292F", sectionBar: "#2B5580" } },
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
      linkedin: emptyNetwork(),
      flickr: emptyNetwork(),
      youtube: emptyNetwork(),
      blogs: emptyNetwork(),
      policyLink: { text: "", url: "" },
      intro: "",
    },
    ministryPages: { ...DEFAULT_MINISTRY_PAGES },
    contactsPage: neutralContactsPage(),
    pageText: neutralPageText(),
    navigation: structuredClone(DEFAULT_NAVIGATION),
  };
}

/** What the site shows before anything is published: the tenant's own settings file when it has
 * one (parsed as a stored document, its missing parts filled from the theme-derived defaults,
 * then validated; throws if it isn't a valid document), else defaults derived from its theme. */
export function defaultSiteSettings(
  tenantTheme: {
    colors: Omit<ThemeColors, "bannerInfo" | "bannerEmergency" | "sectionBar">;
    footerLinks: { label: string; url: string }[];
  },
  tenantDefaults?: unknown,
): SiteSettings {
  const neutral = neutralDefaults(tenantTheme);
  const doc = tenantDefaults !== undefined ? fillMissingFields(storedSiteSettingsSchema.parse(tenantDefaults), neutral) : neutral;
  const errors = validateSiteSettings(doc);
  if (errors.length > 0) {
    throw new Error(`Default site settings are invalid: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
  }
  return doc;
}

/**
 * `doc` (a stored document, `storedSiteSettingsSchema`) with every optional part it lacks taken
 * from `defaults`: a new, complete document; neither input is changed, and no part of the result
 * is shared with `defaults`. A document published before a part existed has no value for it; an
 * explicit value, including "", is the editor's choice and is kept. Each part is filled whole:
 * `footer.landAcknowledgement`, `connect.linkedin`, `connect.policyLink`, `connect.intro`, and
 * the `contactsPage`, `pageText` and `navigation` sections. The single place a later optional
 * part gets its default.
 */
export function fillMissingFields(doc: StoredSiteSettings, defaults: SiteSettings): SiteSettings {
  const fill = <T>(value: T | undefined, fallback: T): T => (value !== undefined ? value : structuredClone(fallback));
  const { connect } = doc;
  return {
    ...doc,
    theme: { colors: { ...doc.theme.colors, sectionBar: fill(doc.theme.colors.sectionBar, defaults.theme.colors.sectionBar) } },
    footer: { ...doc.footer, landAcknowledgement: fill(doc.footer.landAcknowledgement, defaults.footer.landAcknowledgement) },
    // Spelled out in schema (NETWORKS) order, so a filled document serialises like a parsed one
    // (the public site hashes each section's JSON).
    connect: {
      facebook: connect.facebook,
      x: connect.x,
      instagram: connect.instagram,
      threads: connect.threads,
      bluesky: connect.bluesky,
      linkedin: fill(connect.linkedin, defaults.connect.linkedin),
      flickr: connect.flickr,
      youtube: connect.youtube,
      blogs: connect.blogs,
      policyLink: fill(connect.policyLink, defaults.connect.policyLink),
      intro: fill(connect.intro, defaults.connect.intro),
    },
    contactsPage: fill(doc.contactsPage, defaults.contactsPage),
    pageText: fill(doc.pageText, defaults.pageText),
    navigation: fill(doc.navigation, defaults.navigation),
  };
}
