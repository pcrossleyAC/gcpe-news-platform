import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ReleaseRecord } from "@gcpe/events";
import type { Layout, ReleaseStatus, ReleaseType } from "@gcpe/nrms-contract";

export * from "@gcpe/events/tables";

/** Local copy of Core's ministries (org.* events). Keys stored lowercased. */
export const organizations = pgTable("organizations", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  abbreviation: text("abbreviation"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

/** Local copy of Core's sectors, themes and tags (sector.*, theme.*, tag.* events). */
export const categoryTerms = pgTable(
  "category_terms",
  {
    kind: text("kind").$type<"sectors" | "themes" | "tags">().notNull(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const tz = (name: string) => timestamp(name, { withTimezone: true });

export const governmentTerms = pgTable("government_terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  isCurrent: boolean("is_current").notNull().default(false),
  legacyId: uuid("legacy_id"),
}, (t) => [uniqueIndex("government_terms_one_current_idx").on(t.isCurrent).where(sql`${t.isCurrent}`)]);

export const newsReleases = pgTable(
  "news_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legacyId: uuid("legacy_id").unique(),
    type: text("type").$type<ReleaseType>().notNull(),
    key: text("key"),
    reference: text("reference"),
    year: integer("year"),
    yearRelease: integer("year_release"),
    ministryRelease: integer("ministry_release"),
    termId: uuid("term_id").references(() => governmentTerms.id),
    leadMinistryKey: text("lead_ministry_key"),
    activityId: integer("activity_id"),
    status: text("status").$type<ReleaseStatus>().notNull().default("draft"),
    publishAt: tz("publish_at"),
    releasedAt: tz("released_at"),
    onHold: boolean("on_hold").notNull().default(false),
    /** On the public site right now: set by the publisher at go-live, cleared when an unpublish completes. */
    live: boolean("live").notNull().default(false),
    toWeb: boolean("to_web").notNull().default(true),
    toSubscribers: boolean("to_subscribers").notNull().default(false),
    toMediaLists: boolean("to_media_lists").notNull().default(false),
    assetUrl: text("asset_url"),
    assetAltText: text("asset_alt_text"),
    hasMediaAssets: boolean("has_media_assets").notNull().default(false),
    hasTranslations: boolean("has_translations").notNull().default(false),
    redirectUrl: text("redirect_url"),
    keywords: text("keywords"),
    atomId: text("atom_id"),
    nodSubscribers: integer("nod_subscribers"),
    mediaSubscribers: integer("media_subscribers"),
    lastError: text("last_error"),
    /** Phase 3c: the release went out without its Flickr photo (see media/flickr-jobs.ts). */
    flickrAlert: text("flickr_alert"),
    version: integer("version").notNull().default(1),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("news_releases_key_idx").on(sql`lower(${t.key})`).where(sql`${t.key} IS NOT NULL`),
    uniqueIndex("news_releases_reference_idx").on(t.reference).where(sql`${t.reference} IS NOT NULL`),
    index("news_releases_due_idx").on(t.publishAt).where(sql`${t.status} IN ('scheduled','publishing','unpublishing')`),
    index("news_releases_status_idx").on(t.status),
    check("news_releases_type_check", sql`${t.type} IN ('release','story','factsheet','update','advisory')`),
    check("news_releases_status_check", sql`${t.status} IN ('draft','approved','scheduled','publishing','published','unpublishing','failed','deleted')`),
    check("news_releases_committed_has_time", sql`${t.status} NOT IN ('scheduled','publishing','published','unpublishing') OR ${t.publishAt} IS NOT NULL`),
  ],
);
export type NewsReleaseRow = typeof newsReleases.$inferSelect;

const releaseFk = () => uuid("release_id").notNull().references(() => newsReleases.id, { onDelete: "cascade" });

/**
 * Phase 3c: making a release's Flickr photo public before it goes live (media/flickr-jobs.ts).
 * One job per release, for the photo its asset currently points at.
 */
export const flickrJobs = pgTable(
  "flickr_jobs",
  {
    releaseId: uuid("release_id").primaryKey().references(() => newsReleases.id, { onDelete: "cascade" }),
    photoId: text("photo_id").notNull(),
    status: text("status").$type<"pending" | "done" | "gave_up">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    firstAttemptAt: tz("first_attempt_at"),
    nextAttemptAt: tz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    staticUrl: text("static_url"),
    alertedAt: tz("alerted_at"),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("flickr_jobs_status_check", sql`${t.status} IN ('pending','done','gave_up')`),
    index("flickr_jobs_due_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
  ],
);

export const releaseLanguages = pgTable(
  "release_languages",
  {
    releaseId: releaseFk(),
    languageId: integer("language_id").notNull(),
    location: text("location").notNull().default(""),
    summary: text("summary").notNull().default(""),
    summaryEdited: boolean("summary_edited").notNull().default(false),
    socialMediaSummary: text("social_media_summary"),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.languageId] })],
);

export const releaseDocuments = pgTable(
  "release_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: releaseFk(),
    sortIndex: integer("sort_index").notNull(),
    layout: text("layout").$type<Layout>().notNull().default("formal"),
  },
  (t) => [index("release_documents_release_idx").on(t.releaseId, t.sortIndex)],
);

const documentFk = () => uuid("document_id").notNull().references(() => releaseDocuments.id, { onDelete: "cascade" });

export const documentLanguages = pgTable(
  "document_languages",
  {
    documentId: documentFk(),
    languageId: integer("language_id").notNull(),
    pageTitle: text("page_title").notNull(),
    headline: text("headline").notNull().default(""),
    subheadline: text("subheadline"),
    organizations: text("organizations"),
    byline: text("byline"),
    bodyHtml: text("body_html").notNull().default(""),
    pageImageId: uuid("page_image_id"),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.languageId] })],
);

export const documentContacts = pgTable(
  "document_contacts",
  {
    documentId: documentFk(),
    languageId: integer("language_id").notNull(),
    sortIndex: integer("sort_index").notNull(),
    information: text("information").notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.languageId, t.sortIndex] })],
);

export const releaseCategories = pgTable(
  "release_categories",
  {
    releaseId: releaseFk(),
    kind: text("kind").$type<"ministries" | "sectors" | "themes" | "tags">().notNull(),
    key: text("key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.kind, t.key] }), index("release_categories_key_idx").on(t.kind, t.key)],
);

export const mediaLists = pgTable("media_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  displayName: text("display_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  legacyId: uuid("legacy_id"),
});

export const releaseMediaLists = pgTable(
  "release_media_lists",
  {
    releaseId: releaseFk(),
    mediaListId: uuid("media_list_id").notNull().references(() => mediaLists.id),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.mediaListId] })],
);

/** Top/Feature slots: kind 'home' (key 'default'), 'ministries', 'sectors', 'themes'. */
export const categoryFeatures = pgTable(
  "category_features",
  {
    kind: text("kind").$type<"home" | "ministries" | "sectors" | "themes">().notNull(),
    key: text("key").notNull(),
    topReleaseId: uuid("top_release_id").references(() => newsReleases.id, { onDelete: "set null" }),
    featureReleaseId: uuid("feature_release_id").references(() => newsReleases.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const pageImages = pgTable("page_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  mimeType: text("mime_type").notNull(),
  bytes: bytea("bytes").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  legacyId: uuid("legacy_id"),
});

export const pageImageLanguages = pgTable(
  "page_image_languages",
  {
    imageId: uuid("image_id").notNull().references(() => pageImages.id, { onDelete: "cascade" }),
    languageId: integer("language_id").notNull(),
    altText: text("alt_text").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.imageId, t.languageId] })],
);

/** Per-type, per-language page titles (legacy dbo.NewsReleaseType). */
export const pageTypes = pgTable(
  "page_types",
  {
    pageTitle: text("page_title").notNull(),
    languageId: integer("language_id").notNull(),
    releaseType: text("release_type").$type<ReleaseType>().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    layout: text("layout").$type<Layout>().notNull().default("formal"),
    pageImageId: uuid("page_image_id").references(() => pageImages.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.pageTitle, t.languageId] })],
);

/** Approve-time counters (scope 'news' | 'year' | 'ministry'); ministry '' when not per-ministry. */
export const numberCounters = pgTable(
  "number_counters",
  {
    scope: text("scope").notNull(),
    year: integer("year").notNull(),
    ministry: text("ministry").notNull().default(""),
    lastValue: integer("last_value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.year, t.ministry] })],
);

/**
 * Uploaded release files (Phase 3c): French/other-language translation PDFs and media asset
 * files. The bytes live in the object store under `storage_key` (served publicly at
 * `/files/<storage_key>`); this row is the release's record of them.
 */
export const releaseFiles = pgTable(
  "release_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: releaseFk(),
    kind: text("kind").$type<"translation" | "asset">().notNull(),
    storageKey: text("storage_key").notNull().unique(),
    label: text("label").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("release_files_release_kind_idx").on(t.releaseId, t.kind),
    check("release_files_kind_check", sql`${t.kind} IN ('translation','asset')`),
    check("release_files_label_length", sql`char_length(${t.label}) <= 200`),
  ],
);

export const releaseLog = pgTable(
  "release_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    releaseId: releaseFk(),
    at: tz("at").notNull().defaultNow(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("release_log_release_idx").on(t.releaseId, t.at)],
);

export const releasePublications = pgTable(
  "release_publications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    releaseId: releaseFk(),
    publishedAt: tz("published_at").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    record: jsonb("record").$type<ReleaseRecord>().notNull(),
  },
  (t) => [index("release_publications_release_idx").on(t.releaseId, t.publishedAt)],
);
