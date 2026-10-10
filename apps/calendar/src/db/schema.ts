import { sql, type SQL } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { CalendarRole } from "@gcpe/auth";

// The event receiver and the outbox need these in the Calendar's own database.
export * from "@gcpe/events/tables";

const tz = (name: string) => timestamp(name, { withTimezone: true });
/** Legacy integer ids are kept (spec addendum §5.2); new rows draw from the identity, which the
 * importer re-bases above the imported maximum. */
const legacyId = () => integer("id").primaryKey().generatedByDefaultAsIdentity();
const sqlList = (values: readonly string[]): SQL => sql.raw(values.map((v) => `'${v}'`).join(","));
const maxLength = (table: string, column: AnyPgColumn, n: number) => check(`${table}_${column.name}_length`, sql`char_length(${column}) <= ${sql.raw(String(n))}`);

export const ACTIVITY_STATUSES = ["new", "changed", "reviewed"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const HQ_STATUSES = ["new", "changed"] as const;
export type HqStatus = (typeof HQ_STATUSES)[number];
/** Legacy HqSection 1–4 in order (spec addendum §7.6). */
export const HQ_SECTIONS = ["issues_and_reports", "events_and_speeches", "in_the_news", "not_on_la"] as const;
export type HqSection = (typeof HQ_SECTIONS)[number];
/** The 23 needs-review flags (spec addendum §7.3). */
export const NEEDS_REVIEW_KEYS = [
  "title", "details", "representative", "city", "start_date", "end_date", "categories", "comm_materials", "active",
  "significance", "strategy", "scheduling_considerations", "internal_notes", "lead_organization", "initiatives", "tags",
  "origin", "distribution", "translations_required", "premier_requested", "venue", "event_planner", "digital",
] as const;
export type NeedsReviewKey = (typeof NEEDS_REVIEW_KEYS)[number];
export const CHANGE_ACTIONS = ["created", "updated", "cloned", "reviewed", "deleted", "transferred", "la_status_cleared"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];
export const CHANGE_SOURCES = ["calendar", "legacy_log"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];
/** The list's "Display" choice (spec addendum §8.1; legacy FilterDisplayValue). */
export const LIST_DISPLAYS = ["all", "my_ministries", "my_activities", "my_watchlist"] as const;
export type ListDisplay = (typeof LIST_DISPLAYS)[number];
export const TERM_KINDS = ["sector", "theme", "tag"] as const;
export type TermKind = (typeof TERM_KINDS)[number];

// ── Projections of Core (spec addendum §5.2). Keyed by Core key or user id; nothing references
// them by foreign key, because they fill asynchronously from events.

export const orgs = pgTable("orgs", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  abbreviation: text("abbreviation"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull(),
  isHq: boolean("is_hq").notNull().default(false),
});

export const terms = pgTable(
  "terms",
  {
    kind: text("kind").$type<TermKind>().notNull(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] }), check("terms_kind_check", sql`${t.kind} IN (${sqlList(TERM_KINDS)})`)],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name").notNull(),
  isActive: boolean("is_active").notNull(),
  calendarRole: text("calendar_role").$type<CalendarRole>(),
  organizationKeys: text("organization_keys").array().notNull().default(sql`'{}'::text[]`),
});

// ── Lookups (spec addendum §5.2, §5.3). Legacy ids; never deleted, only deactivated.

const lookupColumns = () => ({
  id: legacyId(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

export const categories = pgTable("categories", lookupColumns());
export const cities = pgTable("cities", lookupColumns());
export const commMaterials = pgTable("comm_materials", lookupColumns());
export const eventPlanners = pgTable("event_planners", { ...lookupColumns(), phone: text("phone"), jobTitle: text("job_title") });
export const governmentRepresentatives = pgTable("government_representatives", { ...lookupColumns(), description: text("description") });
export const initiatives = pgTable("initiatives", { ...lookupColumns(), shortName: text("short_name") });
export const keywords = pgTable("keywords", lookupColumns());
export const nrDistributions = pgTable("nr_distributions", lookupColumns());
export const nrOrigins = pgTable("nr_origins", lookupColumns());
export const premierRequested = pgTable("premier_requested", lookupColumns());
export const videographers = pgTable("videographers", { ...lookupColumns(), jobTitle: text("job_title") });

/** Legacy CommunicationContact: one per user × ministry; rank 1 Comm Director … 6 Other (Admin/User.aspx.cs:16-25). */
export const commContacts = pgTable(
  "comm_contacts",
  {
    id: legacyId(),
    userId: uuid("user_id").notNull(),
    ministryKey: text("ministry_key").notNull(),
    rank: integer("rank"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("comm_contacts_user_ministry_idx").on(t.userId, t.ministryKey),
    check("comm_contacts_rank_check", sql`${t.rank} IS NULL OR ${t.rank} BETWEEN 1 AND 6`),
  ],
);

/** Calendar-only contact details and list preferences (spec addendum §4, §5.2). */
export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: uuid("user_id").primaryKey(),
    phone: text("phone"),
    mobile: text("mobile"),
    jobTitle: text("job_title"),
    description: text("description"),
    listDisplay: text("list_display").$type<ListDisplay>(),
    hiddenColumns: text("hidden_columns").array().notNull().default(sql`'{}'::text[]`),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // PhoneNumber was a free NVARCHAR(20) in legacy, with no format check.
    maxLength("user_profiles", t.phone, 20),
    // Legacy's CHECK on MobileNumber: empty, or 12 characters of digits and hyphens.
    check("user_profiles_mobile_check", sql`${t.mobile} IS NULL OR ${t.mobile} = '' OR ${t.mobile} ~ '^[0-9-]{12}$'`),
    check("user_profiles_list_display_check", sql`${t.listDisplay} IS NULL OR ${t.listDisplay} IN (${sqlList(LIST_DISPLAYS)})`),
    maxLength("user_profiles", t.jobTitle, 100),
    maxLength("user_profiles", t.description, 2000),
  ],
);

export const savedFilters = pgTable(
  "saved_filters",
  {
    id: legacyId(),
    ownerId: uuid("owner_id").notNull(),
    name: text("name").notNull(),
    filter: jsonb("filter").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [index("saved_filters_owner_idx").on(t.ownerId), maxLength("saved_filters", t.name, 200)],
);

// ── Activities (spec addendum §5.2: one row per legacy calendar.Activity).

export const activities = pgTable(
  "activities",
  {
    id: legacyId(),
    startAt: tz("start_at"),
    endAt: tz("end_at"),
    nrAt: tz("nr_at"),
    potentialDates: text("potential_dates"),
    isAllDay: boolean("is_all_day").notNull().default(false),
    isConfirmed: boolean("is_confirmed").notNull().default(false),
    title: text("title").notNull().default(""),
    details: text("details").notNull().default(""),
    schedule: text("schedule").notNull().default(""),
    significance: text("significance").notNull().default(""),
    strategy: text("strategy"),
    comments: text("comments"),
    hqComments: text("hq_comments"),
    leadOrganization: text("lead_organization"),
    venue: text("venue"),
    otherCity: text("other_city"),
    translations: text("translations").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").$type<ActivityStatus>().notNull().default("new"),
    hqStatus: text("hq_status").$type<HqStatus>(),
    // Legacy's default HqSection is 2.
    hqSection: text("hq_section").$type<HqSection>().notNull().default("events_and_speeches"),
    longTermOutlook: boolean("long_term_outlook").notNull().default(false),
    nrDistributionId: integer("nr_distribution_id").references(() => nrDistributions.id),
    premierRequestedId: integer("premier_requested_id").references(() => premierRequested.id),
    contactMinistryKey: text("contact_ministry_key"),
    governmentRepresentativeId: integer("government_representative_id").references(() => governmentRepresentatives.id),
    commContactId: integer("comm_contact_id").references(() => commContacts.id),
    eventPlannerId: integer("event_planner_id").references(() => eventPlanners.id),
    videographerId: integer("videographer_id").references(() => videographers.id),
    cityId: integer("city_id").references(() => cities.id),
    isIssue: boolean("is_issue").notNull().default(false),
    isAtLegislature: boolean("is_at_legislature").notNull().default(false),
    isConfidential: boolean("is_confidential").notNull().default(false),
    isCrossGovernment: boolean("is_cross_government").notNull().default(false),
    isMilestone: boolean("is_milestone").notNull().default(false),
    deletedAt: tz("deleted_at"),
    deletedBy: uuid("deleted_by"),
    needsReview: text("needs_review").array().$type<NeedsReviewKey[]>().notNull().default(sql`'{}'::text[]`),
    createdAt: tz("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by"),
    lastUpdatedAt: tz("last_updated_at").notNull().defaultNow(),
    lastUpdatedBy: uuid("last_updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("activities_start_at_idx").on(t.startAt),
    index("activities_end_at_idx").on(t.endAt),
    index("activities_contact_ministry_idx").on(t.contactMinistryKey),
    index("activities_comm_contact_idx").on(t.commContactId),
    check("activities_status_check", sql`${t.status} IN (${sqlList(ACTIVITY_STATUSES)})`),
    check("activities_hq_status_check", sql`${t.hqStatus} IS NULL OR ${t.hqStatus} IN (${sqlList(HQ_STATUSES)})`),
    check("activities_hq_section_check", sql`${t.hqSection} IN (${sqlList(HQ_SECTIONS)})`),
    check("activities_needs_review_check", sql`${t.needsReview} <@ ARRAY[${sqlList(NEEDS_REVIEW_KEYS)}]::text[]`),
    // Legacy's column sizes; the editor's tighter limits on new values are 5c's validation.
    maxLength("activities", t.title, 500),
    maxLength("activities", t.details, 700),
    maxLength("activities", t.schedule, 500),
    maxLength("activities", t.significance, 500),
    maxLength("activities", t.strategy, 500),
    maxLength("activities", t.comments, 4000),
    maxLength("activities", t.hqComments, 2000),
    maxLength("activities", t.leadOrganization, 100),
    maxLength("activities", t.venue, 150),
    maxLength("activities", t.otherCity, 150),
    maxLength("activities", t.potentialDates, 70),
  ],
);

const activityRef = () => integer("activity_id").notNull().references(() => activities.id, { onDelete: "cascade" });

export const activityCategories = pgTable("activity_categories", { activityId: activityRef(), categoryId: integer("category_id").notNull().references(() => categories.id) }, (t) => [primaryKey({ columns: [t.activityId, t.categoryId] })]);
export const activityCommMaterials = pgTable("activity_comm_materials", { activityId: activityRef(), commMaterialId: integer("comm_material_id").notNull().references(() => commMaterials.id) }, (t) => [primaryKey({ columns: [t.activityId, t.commMaterialId] })]);
export const activityInitiatives = pgTable("activity_initiatives", { activityId: activityRef(), initiativeId: integer("initiative_id").notNull().references(() => initiatives.id) }, (t) => [primaryKey({ columns: [t.activityId, t.initiativeId] })]);
/** "HQ Tags". */
export const activityKeywords = pgTable("activity_keywords", { activityId: activityRef(), keywordId: integer("keyword_id").notNull().references(() => keywords.id) }, (t) => [primaryKey({ columns: [t.activityId, t.keywordId] })]);
export const activityNrOrigins = pgTable("activity_nr_origins", { activityId: activityRef(), nrOriginId: integer("nr_origin_id").notNull().references(() => nrOrigins.id) }, (t) => [primaryKey({ columns: [t.activityId, t.nrOriginId] })]);
export const activitySectors = pgTable("activity_sectors", { activityId: activityRef(), termKey: text("term_key").notNull() }, (t) => [primaryKey({ columns: [t.activityId, t.termKey] })]);
export const activityThemes = pgTable("activity_themes", { activityId: activityRef(), termKey: text("term_key").notNull() }, (t) => [primaryKey({ columns: [t.activityId, t.termKey] })]);
/** "News Subscribe". */
export const activityTags = pgTable("activity_tags", { activityId: activityRef(), termKey: text("term_key").notNull() }, (t) => [primaryKey({ columns: [t.activityId, t.termKey] })]);
export const activitySharedWith = pgTable(
  "activity_shared_with",
  { activityId: activityRef(), ministryKey: text("ministry_key").notNull() },
  (t) => [primaryKey({ columns: [t.activityId, t.ministryKey] }), index("activity_shared_with_ministry_idx").on(t.ministryKey)],
);

export const activityFiles = pgTable(
  "activity_files",
  {
    id: legacyId(),
    // Deliberately no cascade: deleting the activity would otherwise orphan the storage blob.
    activityId: integer("activity_id").notNull().references(() => activities.id),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    length: integer("length").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    uploadedAt: tz("uploaded_at").notNull().defaultNow(),
    uploadedBy: uuid("uploaded_by"),
  },
  // Same-name upload replaces (Activity.aspx.cs:1436-1437).
  (t) => [uniqueIndex("activity_files_name_idx").on(t.activityId, t.fileName)],
);

/** The watchlist (legacy FavoriteActivity). */
export const favourites = pgTable(
  "favourites",
  { userId: uuid("user_id").notNull(), activityId: activityRef() },
  (t) => [primaryKey({ columns: [t.userId, t.activityId] }), index("favourites_activity_idx").on(t.activityId)],
);

export const activityChanges = pgTable(
  "activity_changes",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    activityId: activityRef(),
    at: tz("at").notNull().defaultNow(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").$type<ChangeAction>().notNull(),
    source: text("source").$type<ChangeSource>().notNull().default("calendar"),
    contactMinistryKey: text("contact_ministry_key"),
  },
  (t) => [
    index("activity_changes_activity_at_idx").on(t.activityId, t.at),
    index("activity_changes_at_idx").on(t.at),
    check("activity_changes_action_check", sql`${t.action} IN (${sqlList(CHANGE_ACTIONS)})`),
    check("activity_changes_source_check", sql`${t.source} IN (${sqlList(CHANGE_SOURCES)})`),
  ],
);

export const activityChangeFields = pgTable(
  "activity_change_fields",
  {
    changeId: integer("change_id").notNull().references(() => activityChanges.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.fieldKey] })],
);

export const activityLocks = pgTable("activity_locks", {
  activityId: integer("activity_id").primaryKey().references(() => activities.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  tabId: text("tab_id").notNull(),
  acquiredAt: tz("acquired_at").notNull().defaultNow(),
  lastActiveAt: tz("last_active_at").notNull().defaultNow(),
});

/** The projection of NRMS's release.status_changed (spec addendum §11). */
export const releaseLinks = pgTable(
  "release_links",
  {
    releaseId: uuid("release_id").primaryKey(),
    activityId: integer("activity_id").notNull().references(() => activities.id, { onDelete: "cascade" }),
    key: text("key"),
    type: text("type").notNull(),
    status: text("status").notNull(),
    publishAt: tz("publish_at"),
    releasedAt: tz("released_at"),
    reference: text("reference"),
    headline: text("headline"),
    lastSequence: integer("last_sequence").notNull(),
  },
  (t) => [index("release_links_activity_idx").on(t.activityId)],
);
