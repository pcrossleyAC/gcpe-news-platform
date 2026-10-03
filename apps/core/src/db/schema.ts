import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
