import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export * from "@gcpe/events/tables";

/**
 * One row per post page on disk (spec §6.2): what the public site last rendered for the post.
 * The rebuild set compares it with the News API's current post, and the archives and sitemaps
 * are rendered from it (the News API has no by-month query).
 */
export const sitePosts = pgTable(
  "site_posts",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary"),
    /** As the News API formats it: BC-local with its offset. Shown, and used for the month. */
    publishDate: text("publish_date").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    month: text("month").notNull(),
    categories: text("categories").array().notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("site_posts_month_idx").on(t.month, t.publishedAt), index("site_posts_categories_idx").using("gin", t.categories)],
);
