import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { OrgRecord, TermRecord } from "@gcpe/events";

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
  sectorKeys: text("sector_keys").array().notNull().default(sql`'{}'::text[]`),
  /** HQ organization (spec addendum §4, C124): its members see every ministry in the Calendar. */
  isHq: boolean("is_hq").notNull().default(false),
  legacyId: uuid("legacy_id"),
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
    legacyId: uuid("legacy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
    check("users_sign_in_method_check", sql`${t.signInMethod} IN ('local','entra')`),
    check("users_active_needs_email", sql`${t.isActive} = false OR ${t.email} IS NOT NULL`),
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
