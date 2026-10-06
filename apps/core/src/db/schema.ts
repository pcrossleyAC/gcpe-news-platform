import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    email: text("email").notNull(),
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
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);
