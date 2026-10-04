import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { PostKind, ReleaseRecord } from "@gcpe/events";

export * from "@gcpe/events/tables";

export type ReleaseStatus = "draft" | "scheduled" | "published" | "failed";
/** Everything in the published record that the author controls. */
export type ReleaseContent = Omit<ReleaseRecord, "key" | "kind" | "publishDate" | "timestamp" | "atomId" | "renditions">;

export const releases = pgTable(
  "releases",
  {
    key: text("key").primaryKey(),
    kind: text("kind").$type<PostKind>().notNull(),
    status: text("status").$type<ReleaseStatus>().notNull().default("draft"),
    publishAt: timestamp("publish_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    content: jsonb("content").$type<ReleaseContent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("releases_key_lower_idx").on(sql`lower(${t.key})`),
    index("releases_due_idx").on(t.publishAt).where(sql`${t.status} = 'scheduled'`),
    check("releases_status_check", sql`${t.status} IN ('draft','scheduled','published','failed')`),
  ],
);
export type ReleaseRow = typeof releases.$inferSelect;

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
