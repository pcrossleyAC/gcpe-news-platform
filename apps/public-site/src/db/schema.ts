import { bigint, bigserial, check, index, integer, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
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
    /** The lower-cased key of the ministry the release page's side column, related band and
     * story-ministry line show (post-index.ts leadMinistryOf). Not always one of `categories`
     * (legacy has releases whose lead is not among their ministries), so a ministry change finds
     * the release pages it reaches by this column too (change-feed.ts). Null: no ministry, or a
     * row written before this column (every post is re-rendered by the chrome-10 rebuild-all). */
    leadMinistry: text("lead_ministry"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("site_posts_month_idx").on(t.month, t.publishedAt), index("site_posts_categories_idx").using("gin", t.categories), index("site_posts_lead_ministry_idx").on(t.leadMinistry)],
);

/**
 * spec §6.2: pages waiting to be rendered. One row per page; enqueueing again keeps the lower
 * priority and takes a fresh seq, which moves the page to the back of its priority and tells a
 * render already in progress that it must not delete the row (queue.ts).
 */
export const rebuildQueue = pgTable(
  "rebuild_queue",
  {
    pageId: text("page_id").primaryKey(),
    priority: smallint("priority").notNull(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().default(sql`now()`),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index("rebuild_queue_order_idx").on(t.priority, t.seq)],
);

/** One row (id 1): the change-feed cursor (spec §6.2), null until the first sync, and the applied terms hash. */
export const siteState = pgTable(
  "site_state",
  {
    id: integer("id").primaryKey(),
    changeCursor: bigint("change_cursor", { mode: "number" }),
    /** sha256 of the government-terms snapshot the term pages were last queued for (NG-R18):
     * written in the same transaction as those queue rows, null after an outage that rendered
     * without terms, so a differing snapshot always re-queues every term page. */
    termsHash: text("terms_hash"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [check("site_state_single_row", sql`${t.id} = 1`)],
);
