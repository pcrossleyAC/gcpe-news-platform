import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
