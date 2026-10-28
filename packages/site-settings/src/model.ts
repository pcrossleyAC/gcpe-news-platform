import { z } from "zod";

export const NETWORKS = [
  { key: "facebook", name: "Facebook" },
  { key: "x", name: "X" },
  { key: "instagram", name: "Instagram" },
  { key: "threads", name: "Threads" },
  { key: "bluesky", name: "Bluesky" },
  { key: "flickr", name: "Flickr" },
  { key: "youtube", name: "YouTube" },
  { key: "blogs", name: "Blogs" },
] as const;

export type NetworkKey = (typeof NETWORKS)[number]["key"];

export const SECTION_KEYS = ["banner", "theme", "footer", "connect", "ministryPages"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABEL: Record<SectionKey, string> = {
  banner: "Banner",
  theme: "Theme",
  footer: "Footer",
  connect: "Social links",
  ministryPages: "Ministry pages",
};

/** Structural shapes only; the rules (and their messages) live in `validateSiteSettings`. */
const linkSchema = z.object({
  text: z.string(),
  url: z.string(),
  id: z.string().optional(),
  summary: z.string().optional(),
});

const networkSchema = z.object({ featured: z.array(linkSchema), accounts: z.array(linkSchema) });
const instant = z.string().datetime({ offset: true }).nullable();

export const THEME_COLOR_KEYS = [
  "primary", "primaryText", "accent", "text", "mutedText", "surface", "background", "border", "bannerInfo", "bannerEmergency",
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
});

export const MINISTRY_PAGE_LABEL_KEYS = [
  "moreFromMinistry", "ministryWebsite", "ministryPhotos", "ministryVideos", "featuredTopics", "featuredServices", "mediaContacts",
] as const;

export const siteSettingsSchema = z.object({
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
  connect: z.object({
    facebook: networkSchema,
    x: networkSchema,
    instagram: networkSchema,
    threads: networkSchema,
    bluesky: networkSchema,
    flickr: networkSchema,
    youtube: networkSchema,
    blogs: networkSchema,
  }),
  ministryPages: z.object({
    moreFromMinistry: z.string(),
    ministryWebsite: z.string(),
    ministryPhotos: z.string(),
    ministryVideos: z.string(),
    featuredTopics: z.string(),
    featuredServices: z.string(),
    mediaContacts: z.string(),
  }),
});

export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export type BannerSettings = SiteSettings["banner"];
export type ThemeColors = SiteSettings["theme"]["colors"];
export type FooterSettings = SiteSettings["footer"];
export type ConnectSettings = SiteSettings["connect"];
export type MinistryPageLabels = SiteSettings["ministryPages"];
export type LinkSetting = z.infer<typeof linkSchema>;

export interface FieldError {
  field: string;
  message: string;
}
