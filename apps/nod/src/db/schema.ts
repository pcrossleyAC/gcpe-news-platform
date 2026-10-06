import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// The event receiver (mounted in app.ts) needs inbox_events/inbox_positions to exist in this
// app's own database, same as every other app that receives signed events.
export * from "@gcpe/events/tables";

export const SUBSCRIBER_STATUSES = ["pending", "active", "disabled", "deleted"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];
export const SUBSCRIBER_SOURCES = ["self", "admin", "media-hub", "manual-media"] as const;
export type SubscriberSource = (typeof SUBSCRIBER_SOURCES)[number];

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    // Random 32-byte base64url token (set in code, subscribers.ts) — the recipient's key into
    // the manage/unsubscribe page. Not a generated column: Postgres has no base64url primitive.
    manageToken: text("manage_token").notNull().unique(),
    // Phase 2 ruling: subscribers are added already verified through the admin API, standing
    // in for the double opt-in journey that arrives in Phase 4. Only verified subscribers
    // (verifiedAt not null) receive mail.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Phase 4 (spec §3). Timing lives on the subscriber, as in legacy (Subscriber.ImmediateDelivery
    // / DigestDelivery). Only `active` subscribers receive mail.
    status: text("status").$type<SubscriberStatus>().notNull().default("pending"),
    asItHappens: boolean("as_it_happens").notNull().default(true),
    digest: boolean("digest").notNull().default(false),
    source: text("source").$type<SubscriberSource>().notNull().default("self"),
    mediaHubContactId: integer("media_hub_contact_id"),
    // Set when the subscriber unsubscribes, is deleted, or moves to a new address; drives the
    // 90-day purge (4g).
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Bumped to invalidate every unsubscribe token issued so far (tokens.ts): on email change.
    unsubscribeVersion: integer("unsubscribe_version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("subscribers_email_lower_idx").on(sql`lower(${t.email})`),
    check("subscribers_status_check", sql`${t.status} IN ('pending','active','disabled','deleted')`),
    check("subscribers_source_check", sql`${t.source} IN ('self','admin','media-hub','manual-media')`),
  ],
);
export type SubscriberRow = typeof subscribers.$inferSelect;

export const subscriptions = pgTable(
  "subscriptions",
  {
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    // '*' = all news, else an index key such as 'ministries:health' (always stored lowercased).
    listKey: text("list_key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.subscriberId, t.listKey] })],
);
export type SubscriptionRow = typeof subscriptions.$inferSelect;

export const deliveries = pgTable(
  "deliveries",
  {
    releaseKey: text("release_key").notNull(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // P2-R16: frozen on this release's first send attempt (send-jobs.ts's
    // ensureChunksAssigned) so a chunk's membership can't shift between retries — a deleted
    // subscriber (cascades away) or a delivery inserted after chunking was frozen (stays NULL,
    // a "late" delivery not part of this job) would otherwise shift every later chunk's
    // boundaries. NULL until assigned.
    chunkIndex: integer("chunk_index"),
  },
  (t) => [primaryKey({ columns: [t.releaseKey, t.subscriberId] })],
);
export type DeliveryRow = typeof deliveries.$inferSelect;

export type SendJobStatus = "pending" | "sent" | "failed";

export const sendJobs = pgTable(
  "send_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseKey: text("release_key").notNull(),
    kind: text("kind").notNull().default("as_it_happens"),
    subject: text("subject"),
    html: text("html"),
    text: text("text"),
    status: text("status").$type<SendJobStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    // Task 10 (P2-R15): a release can target more than Distribution's 20,000-recipient-per-
    // request limit, so a job's recipients are sent as one or more chunked requests. Keyed by
    // chunk index (as a string — jsonb object keys are always strings), not an array, because
    // chunk indices are frozen (see deliveries.chunkIndex) and can skip around (a chunk with
    // no verified recipients left is never sent) — and because P2-R16 merges newly-accepted
    // chunk ids into this on every attempt, including one that ultimately fails or retries, so
    // a chunk accepted before a later chunk failed is never re-sent as "unknown" next time.
    batchIds: jsonb("batch_ids").$type<Record<string, string>>().notNull().default({}),
    // P2-R16: true once this release's deliveries have had a chunk_index assigned (see
    // send-jobs.ts's ensureChunksAssigned) — checked instead of re-deriving "any chunk_index
    // assigned" from the deliveries table, since a release with zero deliveries (should never
    // happen — as-it-happens.ts skips creating a job then) would otherwise look indistinguishable
    // from "not assigned yet".
    chunksAssigned: boolean("chunks_assigned").notNull().default(false),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("send_jobs_release_key_kind_idx").on(t.releaseKey, t.kind),
    check("send_jobs_status_check", sql`${t.status} IN ('pending','sent','failed')`),
  ],
);
export type SendJobRow = typeof sendJobs.$inferSelect;

export const listCategories = pgTable("list_categories", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** One subscribable list. `listKey` is `<category>:<key>` — the same shape as
 * `@gcpe/events`' `indexKeysFor` output and `subscriptions.list_key`, so matching a release to
 * subscribers stays a plain string comparison. */
export const lists = pgTable(
  "lists",
  {
    listKey: text("list_key").primaryKey(),
    category: text("category").notNull().references(() => listCategories.key),
    key: text("key").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    topicUrl: text("topic_url").notNull().default(""),
  },
  (t) => [uniqueIndex("lists_category_key_idx").on(t.category, t.key)],
);

export const LINK_PURPOSES = ["verify", "manage", "change-email"] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];

/** What a subscriber asked for — stored on a pending link until it's confirmed. */
export interface SubscriberPrefs {
  allNews: boolean;
  listKeys: string[];
  asItHappens: boolean;
  digest: boolean;
}

/** One-time links (spec §3). Only a SHA-256 of the token is stored (C48). */
export const subscriberLinks = pgTable(
  "subscriber_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").$type<LinkPurpose>().notNull(),
    subscriberId: uuid("subscriber_id").references(() => subscribers.id, { onDelete: "cascade" }),
    // Lowercased target address: the address being verified (verify, change-email) or the
    // subscriber's own (manage). Also what the per-address rate limit counts on.
    email: text("email").notNull(),
    pending: jsonb("pending").$type<SubscriberPrefs>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // When the pending preferences (or pending email change) were applied. The link keeps
    // working as a manage session until it expires.
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    index("subscriber_links_email_created_idx").on(t.email, t.createdAt),
    check("subscriber_links_purpose_check", sql`${t.purpose} IN ('verify','manage','change-email')`),
  ],
);

/** Replaces legacy SysLog for subscribers: feeds the History screen and reports (4f). */
export const subscriberHistory = pgTable(
  "subscriber_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id").notNull().references(() => subscribers.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
  },
  (t) => [index("subscriber_history_subscriber_at_idx").on(t.subscriberId, t.at)],
);
