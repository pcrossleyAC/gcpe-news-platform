import { z } from "zod";

export const NETWORKS = [
  { key: "facebook", name: "Facebook" },
  { key: "x", name: "X" },
  { key: "instagram", name: "Instagram" },
  { key: "threads", name: "Threads" },
  { key: "bluesky", name: "Bluesky" },
  { key: "linkedin", name: "LinkedIn" },
  { key: "flickr", name: "Flickr" },
  { key: "youtube", name: "YouTube" },
  { key: "blogs", name: "Blogs" },
] as const;

export type NetworkKey = (typeof NETWORKS)[number]["key"];

export const SECTION_KEYS = ["banner", "theme", "footer", "connect", "ministryPages", "contactsPage", "pageText", "navigation", "siteIdentity"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABEL: Record<SectionKey, string> = {
  banner: "Banner",
  theme: "Theme",
  footer: "Footer",
  connect: "Social links",
  ministryPages: "Ministry pages",
  contactsPage: "Media contacts page",
  pageText: "Page text",
  navigation: "Navigation and labels",
  siteIdentity: "Site identity",
};

/** Structural shapes only; the rules (and their messages) live in `validateSiteSettings`. */
const linkSchema = z.object({
  text: z.string(),
  url: z.string(),
  id: z.string().optional(),
  summary: z.string().optional(),
});

/**
 * `collapseAfter`: how many entries the Connect page shows before its Expand button (absent: 2, as
 * legacy's lists; 0: the list never collapses). Optional everywhere: absent is a value, and an older
 * document lacks it (`fillMissingFields` takes the tenant default when there is one).
 */
const networkSchema = z.object({ featured: z.array(linkSchema), accounts: z.array(linkSchema), collapseAfter: z.number().optional() });
const instant = z.string().datetime({ offset: true }).nullable();

export const THEME_COLOR_KEYS = [
  "primary", "primaryText", "accent", "text", "mutedText", "surface", "background", "border", "bannerInfo", "bannerEmergency", "sectionBar",
] as const;

const colorsSchema = z.object({
  primary: z.string(),
  primaryText: z.string(),
  accent: z.string(),
  text: z.string(),
  mutedText: z.string(),
  surface: z.string(),
  background: z.string(),
  border: z.string(),
  bannerInfo: z.string(),
  bannerEmergency: z.string(),
  /** The Connect page's section bars (news.gov's #2b5580). */
  sectionBar: z.string(),
});

export const MINISTRY_PAGE_LABEL_KEYS = [
  "moreFromMinistry", "ministryWebsite", "ministryPhotos", "ministryVideos", "featuredTopics", "featuredServices", "mediaContacts",
] as const;

/** Navigation label keys (`navigation.labels`): the header, home and listing labels staff can edit. */
export const LABEL_KEYS = [
  "connectWithUs", "viewAllSocialMedia", "resources", "newsBySector", "emergencyInformation", "highlights", "latestNews", "loadMoreNews",
  "searchNews", "browseMoreNews", "slideActionLabel",
] as const;

/** The per-kind listings (`/releases/`, …) whose titles `navigation.listingTitles` holds. */
export const LISTING_KINDS = ["releases", "stories", "factsheets", "updates"] as const;

const stringFields = <K extends string>(keys: readonly K[]) =>
  z.object(Object.fromEntries(keys.map((k) => [k, z.string()])) as Record<K, z.ZodString>);

const directoryContactSchema = z.object({
  group: z.string(),
  groupUrl: z.string(),
  subgroup: z.string(),
  name: z.string(),
  phone: z.string(),
  cell: z.string(),
  email: z.string(),
  placement: z.enum(["top", "bottom"]),
});

const contactsPageSchema = z.object({
  heading: z.string(),
  lineHeading: z.string(),
  introHtml: z.string(),
  listHeading: z.string(),
  contacts: z.array(directoryContactSchema),
});

const pageTextSchema = z.object({
  notFound: z.object({ heading: z.string(), text: z.string() }),
  privacy: z.object({ label: z.string(), title: z.string(), bodyHtml: z.string() }),
  live: z.object({ heading: z.string(), consentHtml: z.string(), offAirHtml: z.string() }),
  collectionNotice: z.object({ heading: z.string(), bodyHtml: z.string() }),
  subscribeHelpHtml: z.string(),
  assetLicence: z.object({ text: z.string(), linkText: z.string(), url: z.string() }),
  searchArchiveLinks: z.array(linkSchema),
});

const navigationSchema = z.object({
  newsLabel: z.string(),
  liveLabel: z.string(),
  headerLinks: z.array(linkSchema),
  showHeaderSearch: z.boolean(),
  footerConnectHeading: z.string(),
  footerMoreInfoHeading: z.string(),
  labels: stringFields(LABEL_KEYS),
  listingTitles: stringFields(LISTING_KINDS),
});

/** The `{age}` placeholder in `siteIdentity.blueBridge.message`: replaced by the age at the birth date. */
export const BLUE_BRIDGE_AGE_TOKEN = "{age}";

const siteIdentitySchema = z.object({
  description: z.string(),
  twitterSite: z.string(),
  blueBridge: z.object({ message: z.string(), birthDate: z.string() }),
});

const policyLinkSchema = z.object({ text: z.string(), url: z.string() });

/** One network list per `NETWORKS` key, in `NETWORKS` order; `linkedin` (added later) is optional
 * in a stored document. Key order matters: zod outputs it, and the public site hashes JSON. */
const connectShape = <L extends z.ZodTypeAny, P extends z.ZodTypeAny, I extends z.ZodTypeAny>(linkedin: L, policyLink: P, intro: I) =>
  z.object({
    facebook: networkSchema,
    x: networkSchema,
    instagram: networkSchema,
    threads: networkSchema,
    bluesky: networkSchema,
    linkedin,
    flickr: networkSchema,
    youtube: networkSchema,
    blogs: networkSchema,
    policyLink,
    intro,
  });

const ministryPagesSchema = z.object({
  moreFromMinistry: z.string(),
  ministryWebsite: z.string(),
  ministryPhotos: z.string(),
  ministryVideos: z.string(),
  featuredTopics: z.string(),
  featuredServices: z.string(),
  mediaContacts: z.string(),
});

/** The first sections, in document order (`connect` and `ministryPages` follow). */
const commonSections = {
  schemaVersion: z.literal(1),
  banner: z.object({
    enabled: z.boolean(),
    style: z.enum(["info", "emergency"]),
    message: z.string(),
    links: z.array(z.object({ text: z.string(), url: z.string(), id: z.string().optional(), summary: z.string().optional() })),
    dismissible: z.boolean(),
    startsAt: instant,
    endsAt: instant,
  }),
  theme: z.object({ colors: colorsSchema }),
  footer: z.object({
    helpText: z.string(),
    helpLinks: z.array(linkSchema),
    connectLinks: z.array(linkSchema),
    moreInfoLinks: z.array(linkSchema),
    copyrightHolder: z.string(),
    /** Optional so every document and event published before it existed still parses; `fillMissingFields` supplies the tenant default. */
    landAcknowledgement: z.string().optional(),
  }),
};

/**
 * A complete settings document: what every consumer works with, what a publish validates, and
 * (per section, `.shape[section]`) what a Hub section edit must parse as.
 */
export const siteSettingsSchema = z.object({
  ...commonSections,
  connect: connectShape(networkSchema, policyLinkSchema, z.string()),
  ministryPages: ministryPagesSchema,
  contactsPage: contactsPageSchema,
  pageText: pageTextSchema,
  navigation: navigationSchema,
  siteIdentity: siteIdentitySchema,
});

/**
 * A document as stored or sent (NRMS revisions and drafts, `site.settings.published` events, the
 * News API's copy, the public site's persisted copy): the parts added in parity plan 4 are
 * optional, because a document published before them lacks them. `schemaVersion` stays 1. Parse
 * with this, then `fillMissingFields(doc, tenantDefaults)` to get a complete `SiteSettings`.
 */
export const storedSiteSettingsSchema = z.object({
  ...commonSections,
  /** `sectionBar` is optional: a document published before it existed lacks it (`fillMissingFields`). */
  theme: z.object({ colors: colorsSchema.extend({ sectionBar: z.string().optional() }) }),
  connect: connectShape(networkSchema.optional(), policyLinkSchema.optional(), z.string().optional()),
  ministryPages: ministryPagesSchema,
  contactsPage: contactsPageSchema.optional(),
  pageText: pageTextSchema.optional(),
  navigation: navigationSchema.optional(),
  /** Optional: a document published before parity plan 5 lacks it (`fillMissingFields`). */
  siteIdentity: siteIdentitySchema.optional(),
});

export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export type StoredSiteSettings = z.infer<typeof storedSiteSettingsSchema>;
export type BannerSettings = SiteSettings["banner"];
export type ThemeColors = SiteSettings["theme"]["colors"];
export type FooterSettings = SiteSettings["footer"];
export type ConnectSettings = SiteSettings["connect"];
export type MinistryPageLabels = SiteSettings["ministryPages"];
export type LinkSetting = z.infer<typeof linkSchema>;
export type DirectoryContact = z.infer<typeof directoryContactSchema>;
export type ContactsPageSettings = SiteSettings["contactsPage"];
export type PageTextSettings = SiteSettings["pageText"];
export type NavigationSettings = SiteSettings["navigation"];
export type SiteIdentitySettings = SiteSettings["siteIdentity"];
export type LabelKey = (typeof LABEL_KEYS)[number];
export type ListingKind = (typeof LISTING_KINDS)[number];

export interface FieldError {
  field: string;
  message: string;
}
