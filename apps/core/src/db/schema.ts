import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { OrgRecord, TermRecord } from "@gcpe/events";
import type { LegacyExtras } from "../services/legacy-extras";

export * from "@gcpe/events/tables";

type Contact = NonNullable<OrgRecord["contact"]>;
type Link = OrgRecord["topicLinks"][number];

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  displayName: text("display_name").notNull(),
  abbreviation: text("abbreviation"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  parentKey: text("parent_key"),
  url: text("url"),
  displayAdditionalName: text("display_additional_name"),
  minister: jsonb("minister").$type<OrgRecord["minister"]>().notNull(),
  contact: jsonb("contact").$type<Contact | null>(),
  secondContact: jsonb("second_contact").$type<Contact | null>(),
  weekendContactNumber: text("weekend_contact_number"),
  social: jsonb("social").$type<OrgRecord["social"]>().notNull(),
  topicLinks: jsonb("topic_links").$type<Link[]>().notNull().default([]),
  serviceLinks: jsonb("service_links").$type<Link[]>().notNull().default([]),
  teamLinks: jsonb("team_links").$type<Link[]>().notNull().default([]),
  sectorKeys: text("sector_keys").array().notNull().default(sql`'{}'::text[]`),
  /** HQ organization (spec addendum §4, C124): its members see every ministry in the Calendar. */
  isHq: boolean("is_hq").notNull().default(false),
  /** Listed on public surfaces (Q54). False for GCPE Headquarters and GCPE Media Relations. */
  isPublic: boolean("is_public").notNull().default(true),
  /** Ordered successor ministries, set by a hand-over (new-government spec §4); the first is the redirect target. Cleared on reactivation. */
  successorKeys: text("successor_keys").array().notNull().default(sql`'{}'::text[]`),
  legacyId: uuid("legacy_id"),
  /** Raw legacy HTML news.gov never displayed (owner decision 2026-10-28). Written only by the legacy importer; never rendered, edited or published. Not part of OrgRecord. */
  legacyExtras: jsonb("legacy_extras").$type<LegacyExtras | null>(),
  /** Set when staff edit the organization from the Hub; the seed and importer leave such rows alone. Not part of OrgRecord. */
  staffEditedAt: timestamp("staff_edited_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const terms = pgTable(
  "terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<TermRecord["kind"]>().notNull(),
    key: text("key").notNull(),
    displayName: text("display_name"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    social: jsonb("social").$type<TermRecord["social"]>().notNull(),
    legacyId: uuid("legacy_id"),
    /** As organizations.legacyExtras: sectors only. Not part of TermRecord. */
    legacyExtras: jsonb("legacy_extras").$type<LegacyExtras | null>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("terms_kind_key").on(t.kind, t.key)],
);

/** Staff users (spec addendum §2). Emails are stored trimmed and lowercased. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null only for an inactive user: legacy Calendar users with no email (spec addendum §4). */
    email: text("email"),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    signInMethod: text("sign_in_method").$type<"local" | "entra">().notNull().default("local"),
    passwordHash: text("password_hash"),
    /** The Entra object id (`oid`) this user signs in as, once linked. Set together with sign_in_method 'entra'. */
    entraOid: text("entra_oid"),
    legacyId: uuid("legacy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
    uniqueIndex("users_entra_oid_idx").on(t.entraOid),
    check("users_sign_in_method_check", sql`${t.signInMethod} IN ('local','entra')`),
    check("users_active_needs_email", sql`${t.isActive} = false OR ${t.email} IS NOT NULL`),
    // Linked to Entra exactly when signing in with Entra: a linked user never has a usable password.
    check("users_entra_link_check", sql`(${t.signInMethod} = 'entra') = (${t.entraOid} IS NOT NULL)`),
  ],
);

export const roleGrants = pgTable(
  "role_grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    // A user holds at most one Calendar role (spec addendum §4); granting one replaces the other.
    uniqueIndex("role_grants_one_calendar_role").on(t.userId).where(sql`${t.role} LIKE 'Calendar.%'`),
  ],
);

/** A user's ministries, M(u) in the spec addendum (§4): the Calendar's scope only. NRMS and NoD roles stay flat. */
export const userOrganizations = pgTable(
  "user_organizations",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] }), index("user_organizations_organization_idx").on(t.organizationId)],
);

/** Legacy user ids (spec addendum §4): several legacy SystemUser ids may point to one user when legacy emails repeat. Written by the Calendar importer. */
export const userLegacyIds = pgTable(
  "user_legacy_ids",
  {
    system: text("system").$type<"calendar">().notNull(),
    legacyId: text("legacy_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.system, t.legacyId] }),
    index("user_legacy_ids_user_idx").on(t.userId),
    check("user_legacy_ids_system_check", sql`${t.system} IN ('calendar')`),
  ],
);

/**
 * A staged cabinet change (new-government spec §5): ministry operations saved as a draft, previewed,
 * then published in one transaction, now or at `scheduled_for`. At most one change is open (draft or
 * scheduled) at a time.
 */
export const cabinetChanges = pgTable(
  "cabinet_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").$type<"draft" | "scheduled" | "published" | "cancelled">().notNull().default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    /** The draft's operations, as cabinetOperationSchema parsed them (services/cabinet-changes.ts). */
    operations: jsonb("operations").$type<unknown[]>().notNull().default([]),
    createdBy: text("created_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Why the last scheduled publish failed; cleared when it is saved, scheduled or published again. */
    error: text("error"),
    /**
     * Deadlocks or serialization failures the scheduler has hit publishing it at the current
     * scheduled time. One earns a retry on the next tick; a second sends it back to draft. Stored,
     * not in memory, so the bound holds on SiteGround, where each tick may be a fresh process.
     * Reset whenever it is saved or scheduled.
     */
    transientFailures: integer("transient_failures").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cabinet_changes_status_check", sql`${t.status} IN ('draft','scheduled','published','cancelled')`),
    check("cabinet_changes_scheduled_for_check", sql`${t.status} <> 'scheduled' OR ${t.scheduledFor} IS NOT NULL`),
    uniqueIndex("cabinet_changes_one_open_idx").on(sql`(true)`).where(sql`${t.status} IN ('draft','scheduled')`),
  ],
);
