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
}, (t) => [
  uniqueIndex("government_terms_one_current_idx").on(t.isCurrent).where(sql`${t.isCurrent}`),
  // Phase 3e importer (task 2 fix round 1): backs the upsert-by-legacy-id's ON CONFLICT target.
  uniqueIndex("government_terms_legacy_id_idx").on(t.legacyId).where(sql`${t.legacyId} IS NOT NULL`),
]);

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
    /**
     * Phase 3e (NRMS legacy importer, apps/nrms/src/import/): the `version` this row had the
     * last time the importer wrote it. A later NRMS edit bumps `version` past this, which the
     * re-run detects (its own `version` is higher than `imported_version`) and skips the row
     * rather than overwriting the edit with stale legacy data.
     */
    importedVersion: integer("imported_version"),
    importedAt: tz("imported_at"),
    /** SHA-256 of the mapped release plus its children, so a re-run with unchanged legacy data is a no-op. */
    importHash: text("import_hash"),
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
}, (t) => [
  // Phase 3e importer (task 2 fix round 1): backs the upsert-by-legacy-id's ON CONFLICT target.
  uniqueIndex("media_lists_legacy_id_idx").on(t.legacyId).where(sql`${t.legacyId} IS NOT NULL`),
]);

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
}, (t) => [
  // Phase 3e importer (task 2 fix round 1): backs the upsert-by-legacy-id's ON CONFLICT target.
  uniqueIndex("page_images_legacy_id_idx").on(t.legacyId).where(sql`${t.legacyId} IS NOT NULL`),
]);

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

// --- Phase 3d: Website section (home-page carousel, emergency pins, live feed / Blue Bridge
// settings, resource links, general file uploads and the site activity log). See
// .superpowers/sdd/2026-10-04-phase-3d-website-section/. ---

const justify = () => text("justify").$type<"left" | "right">().notNull().default("left");

/**
 * The home-page carousel: at most one `live` (shown on the public site) and one `next`
 * (queued to go live at `go_live_at`); older carousels are kept as `past`, capped at five by
 * the service layer (Task 2) — the DB only enforces the live/next cardinality and that a
 * `next` carousel always carries a go-live time.
 */
export const carousels = pgTable(
  "carousels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").$type<"live" | "next" | "past">().notNull(),
    goLiveAt: tz("go_live_at"),
    wentLiveAt: tz("went_live_at"),
    version: integer("version").notNull().default(1),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("carousels_state_check", sql`${t.state} IN ('live','next','past')`),
    check("carousels_next_has_go_live_at", sql`${t.state} <> 'next' OR ${t.goLiveAt} IS NOT NULL`),
    uniqueIndex("carousels_one_live_idx").on(t.state).where(sql`${t.state} = 'live'`),
    uniqueIndex("carousels_one_next_idx").on(t.state).where(sql`${t.state} = 'next'`),
  ],
);

export const websiteSlides = pgTable(
  "slides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    carouselId: uuid("carousel_id").notNull().references(() => carousels.id, { onDelete: "cascade" }),
    sortIndex: integer("sort_index").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary").notNull().default(""),
    actionUrl: text("action_url").notNull().default(""),
    facebookPostUrl: text("facebook_post_url").notNull().default(""),
    justify: justify(),
    image: bytea("image"),
    imageType: text("image_type"),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("slides_carousel_sort_idx").on(t.carouselId, t.sortIndex),
    check("slides_justify_check", sql`${t.justify} IN ('left','right')`),
  ],
);

/**
 * The two emergency-pin slots (above the carousel when `pinned`). `slide_id` is a stable id
 * (independent of any carousel slide) used as the emitted slide's `id`, so pinning/unpinning
 * doesn't change the id the public site sees for the same pin.
 */
export const emergencyPins = pgTable(
  "emergency_pins",
  {
    slot: text("slot").$type<"primary" | "secondary">().primaryKey(),
    pinned: boolean("pinned").notNull().default(false),
    slideId: uuid("slide_id").notNull().defaultRandom(),
    headline: text("headline").notNull().default(""),
    summary: text("summary").notNull().default(""),
    actionUrl: text("action_url").notNull().default(""),
    facebookPostUrl: text("facebook_post_url").notNull().default(""),
    justify: justify(),
    image: bytea("image"),
    imageType: text("image_type"),
    version: integer("version").notNull().default(1),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("emergency_pins_slot_check", sql`${t.slot} IN ('primary','secondary')`),
    check("emergency_pins_justify_check", sql`${t.justify} IN ('left','right')`),
  ],
);

/** Single-row settings: live feed, Project Blue Bridge's `granville` text, and the resource links' own version counter. */
export const siteSettings = pgTable(
  "site_settings",
  {
    id: integer("id").primaryKey().default(1),
    liveFeedEnabled: boolean("live_feed_enabled").notNull().default(false),
    liveManifestUrl: text("live_manifest_url").notNull().default(""),
    liveM3uUrl: text("live_m3u_url").notNull().default(""),
    granville: text("granville"),
    linksVersion: integer("links_version").notNull().default(1),
    version: integer("version").notNull().default(1),
    /** Phase 3e importer (Task 4): the website `version` after the last import, and when it ran. */
    websiteImportedAt: tz("website_imported_at"),
    websiteImportedVersion: integer("website_imported_version"),
    /** Phase 3e importer (Task 4, fix round 1): a stable hash of the whole mapped website
     * bundle (carousels/slides/pins/live-feed/granville/links) as of the last import — an
     * unchanged re-run matches this and makes no writes at all, so wholesale-replaced tables
     * (which have no legacy id to diff by) don't get fresh ids on every no-op run. */
    websiteImportHash: text("website_import_hash"),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("site_settings_id_check", sql`${t.id} = 1`)],
);

export const websiteResourceLinks = pgTable("resource_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  sortIndex: integer("sort_index").notNull(),
  text: text("text").notNull(),
  url: text("url").notNull(),
});

/** General file uploads (Task 3); bytes live in the object store under `storage_key`, as release_files does. */
export const siteFiles = pgTable("site_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  storageKey: text("storage_key").notNull().unique(),
  name: text("name").notNull().unique(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
});

export type SiteLogArea = "carousel" | "pins" | "live-feed" | "blue-bridge" | "links" | "files" | "features";

export const siteLog = pgTable(
  "site_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: tz("at").notNull().defaultNow(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    area: text("area").$type<SiteLogArea>().notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    index("site_log_at_idx").on(t.at.desc()),
    check("site_log_area_check", sql`${t.area} IN ('carousel','pins','live-feed','blue-bridge','links','files','features')`),
  ],
);
