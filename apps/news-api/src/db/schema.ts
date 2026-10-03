import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { OrgRecord, ReleaseRecord } from "@gcpe/events";

export * from "@gcpe/events/tables";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const posts = pgTable(
  "posts",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    reference: text("reference"),
    atomId: text("atom_id"),
    publishDate: timestamp("publish_date", { withTimezone: true }).notNull(),
    leadMinistryKey: text("lead_ministry_key"),
    summary: text("summary"),
    socialMediaSummary: text("social_media_summary"),
    socialMediaHeadline: text("social_media_headline"),
    keywords: text("keywords"),
    location: text("location"),
    hasMediaAssets: boolean("has_media_assets").notNull(),
    hasTranslations: boolean("has_translations").notNull(),
    isNewsOnDemand: boolean("is_news_on_demand").notNull(),
    assetUrl: text("asset_url"),
    redirectUri: text("redirect_uri"),
    documents: jsonb("documents").$type<ReleaseRecord["documents"]>().notNull(),
    ministryKeys: text("ministry_keys").array().notNull(),
    sectorKeys: text("sector_keys").array().notNull(),
    tagKeys: text("tag_keys").array().notNull(),
    themeKeys: text("theme_keys").array().notNull(),
    indexKeys: text("index_keys").array().notNull(),
    assets: jsonb("assets").$type<ReleaseRecord["assets"]>(),
    translations: jsonb("translations").$type<ReleaseRecord["translations"]>(),
    isPublished: boolean("is_published").notNull().default(true),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("posts_key_lower_idx").on(sql`lower(${t.key})`),
    index("posts_reference_lower_idx").on(sql`lower(${t.reference})`),
    index("posts_publish_date_idx").on(t.publishDate.desc()),
    index("posts_index_keys_idx").using("gin", t.indexKeys),
  ],
);

export type MinistryDetails = Pick<
  OrgRecord,
  "parentKey" | "url" | "displayAdditionalName" | "minister" | "contact" | "secondContact" | "weekendContactNumber" | "topicLinks" | "serviceLinks"
>;

export const categories = pgTable(
  "categories",
  {
    kind: text("kind").notNull(), // ministries | sectors | themes | tags
    key: text("key").notNull(),
    name: text("name"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull(),
    social: jsonb("social").$type<OrgRecord["social"]>().notNull(),
    ministry: jsonb("ministry").$type<MinistryDetails | null>(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] }), uniqueIndex("categories_kind_key_lower_idx").on(t.kind, sql`lower(${t.key})`)],
);

export const categoryFeatures = pgTable(
  "category_features",
  {
    kind: text("kind").notNull(),
    key: text("key").notNull(), // stored lowercased
    topPostKey: text("top_post_key"),
    featurePostKey: text("feature_post_key"),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const home = pgTable("home", {
  key: text("key").primaryKey().default("default"),
  topPostKey: text("top_post_key"),
  featurePostKey: text("feature_post_key"),
  liveWebcastFlashMediaManifestUrl: text("live_webcast_flash_media_manifest_url"),
  liveWebcastM3uPlaylist: text("live_webcast_m3u_playlist"),
  granville: text("granville"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export const slides = pgTable("slides", {
  id: uuid("id").primaryKey(),
  sortIndex: integer("sort_index").notNull(),
  headline: text("headline"),
  summary: text("summary"),
  actionLabel: text("action_label"),
  actionUri: text("action_uri"),
  image: bytea("image"),
  imageType: text("image_type"),
  facebookPostUri: text("facebook_post_uri"),
  justify: text("justify"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export const resourceLinks = pgTable("resource_links", {
  sortIndex: integer("sort_index").primaryKey(),
  text: text("text").notNull(),
  uri: text("uri").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export type PostRow = typeof posts.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type FeatureRow = typeof categoryFeatures.$inferSelect;
export type HomeRow = typeof home.$inferSelect;
export type SlideRow = typeof slides.$inferSelect;
export type ResourceLinkRow = typeof resourceLinks.$inferSelect;
