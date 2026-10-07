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
    // The chosen email's contract `ref` ("personal" or "workplace:<id>") for a Media Hub-sourced
    // member (4c Task 4's sync writes/reads this; Task 2 only adds the column).
    mediaHubEmailRef: text("media_hub_email_ref"),
    // A short reason a media-list member needs staff attention instead of being silently
    // deleted (C59) -- a collided Media Hub email (media-hub/sync.ts: "email-gone",
    // "email-invalid", "email-taken"), or a hard-bounced address (bounces.ts: "bouncing").
    // Null = fine. Set together with attentionAt.
    needsAttention: text("needs_attention"),
    attentionAt: timestamp("attention_at", { withTimezone: true }),
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

export const ITEM_KINDS = ["release", "emergency"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What NoD sends (spec §3): a published release, or an emergency alert. */
export const items = pgTable(
  "items",
  {
    key: text("key").primaryKey(),
    kind: text("kind").$type<ItemKind>().notNull(),
    // NRMS post kind (releases|stories|factsheets|updates|advisories); null for emergency items.
    postKind: text("post_kind"),
    // `<category>:<key>` like subscriptions.list_key, lowercased.
    listKeys: text("list_keys").array().notNull().default(sql`'{}'::text[]`),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    toSubscribers: boolean("to_subscribers").notNull().default(true),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // The release's full-text media copy (NRMS's `renderText`) and the
    // `media-distribution-lists:<key>` list keys it goes to -- both null/empty unless the
    // release's `publishFlags.toMediaLists` was set. Kept separate from `listKeys` (which never
    // carries a media key) so As-It-Happens/digest matching is untouched by media recipients.
    mediaText: text("media_text"),
    mediaListKeys: text("media_list_keys").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [index("items_published_at_idx").on(t.publishedAt), check("items_kind_check", sql`${t.kind} IN ('release','emergency')`)],
);
export type ItemRow = typeof items.$inferSelect;

export const DELIVERY_MODES = ["as_it_happens", "digest", "media"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const deliveries = pgTable(
  "deliveries",
  {
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Phase 4b sending model: `items.key` this delivery is for.
    itemKey: text("item_key").notNull(),
    mode: text("mode").$type<DeliveryMode>().notNull().default("as_it_happens"),
    jobId: uuid("job_id").references(() => sendJobs.id, { onDelete: "set null" }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    // Distribution's own batch id for the chunk/part this delivery was actually handed off in
    // (send-jobs.ts's sendAllChunks, stamped right after distribution.send returns) -- what a
    // `delivery.bounced` event's own batchId is matched against first (bounces.ts).
    distributionBatchId: uuid("distribution_batch_id"),
    // Set once, on this delivery's first hard bounce (bounces.ts); never cleared, and never
    // moved by a later bounce of either kind for the same delivery.
    hardBouncedAt: timestamp("hard_bounced_at", { withTimezone: true }),
    // The bounce's own status code/string (e.g. "5.1.1", or legacy's numeric "550"), from
    // whichever bounce -- hard or soft -- first set it for this delivery.
    bounceStatus: text("bounce_status"),
  },
  (t) => [
    primaryKey({ columns: [t.itemKey, t.subscriberId, t.mode] }),
    check("deliveries_mode_check", sql`${t.mode} IN ('as_it_happens','digest','media')`),
    // Filtered by the per-part attempted_at stamp (send-jobs.ts's sendAllChunks), the digest
    // claim's own read of this job's items, withdrawItem/createItemSend's deletes, and the
    // ON DELETE SET NULL FK check on sendJobs — none of which had an index to use.
    index("deliveries_job_id_idx").on(t.jobId),
    // bounces.ts's own first match attempt: a delivery.bounced event's batchId against this
    // subscriber's deliveries.
    index("deliveries_distribution_batch_id_idx").on(t.distributionBatchId),
    // bounces.ts's fallback match and its threshold query: both scan this subscriber's own
    // deliveries ordered by attempted_at.
    index("deliveries_subscriber_attempted_at_idx").on(t.subscriberId, t.attemptedAt),
  ],
);
export type DeliveryRow = typeof deliveries.$inferSelect;

export type SendJobStatus = "pending" | "sent" | "failed" | "cancelled";

export const sendJobs = pgTable(
  "send_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    // chunk indices are frozen (see jobRecipients.chunkIndex) and can skip around (a chunk with
    // no verified recipients left is never sent) — and because P2-R16 merges newly-accepted
    // chunk ids into this on every attempt, including one that ultimately fails or retries, so
    // a chunk accepted before a later chunk failed is never re-sent as "unknown" next time.
    batchIds: jsonb("batch_ids").$type<Record<string, string>>().notNull().default({}),
    // P2-R16: true once this job's recipients have had a chunk_index assigned (see
    // send-jobs.ts's ensureChunksAssigned) — checked instead of re-deriving "any chunk_index
    // assigned" from job_recipients, since a job with zero recipients (should never happen —
    // as-it-happens.ts skips creating a job then) would otherwise look indistinguishable from
    // "not assigned yet".
    chunksAssigned: boolean("chunks_assigned").notNull().default(false),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Phase 4b sending model: `<kind>:<itemKey>` (or digest/media's own shape, decided in later
    // tasks) — the job's own stable identity, replacing (release_key, kind) as the unique key.
    jobKey: text("job_key").notNull(),
    // Distribution's priority name (immediate/digest/media/system) — see global constraints.
    priority: text("priority").$type<"immediate" | "digest" | "media" | "system">().notNull().default("immediate"),
    // Phase 4b sending model: `items.key` this job is for.
    itemKey: text("item_key"),
  },
  (t) => [
    uniqueIndex("send_jobs_job_key_idx").on(t.jobKey),
    check("send_jobs_status_check", sql`${t.status} IN ('pending','sent','failed','cancelled')`),
    check("send_jobs_priority_check", sql`${t.priority} IN ('immediate','digest','media','system')`),
  ],
);
export type SendJobRow = typeof sendJobs.$inferSelect;

/** Who a send job goes to. Chunk indices are frozen on first attempt (P2-R16), per job. */
export const jobRecipients = pgTable(
  "job_recipients",
  {
    jobId: uuid("job_id").notNull().references(() => sendJobs.id, { onDelete: "cascade" }),
    subscriberId: uuid("subscriber_id").notNull().references(() => subscribers.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.subscriberId] })],
);

export const nodSettings = pgTable(
  "nod_settings",
  {
    id: integer("id").primaryKey().default(1),
    paused: boolean("paused").notNull().default(false),
    lastDigestCutoff: timestamp("last_digest_cutoff", { withTimezone: true }),
    // The Media Hub changes feed's own cursor -- the `since` to pass `changes()` next time,
    // advanced only once a whole run's feed has been processed to completion.
    mediaSyncSince: timestamp("media_sync_since", { withTimezone: true }),
    // When a sync (scheduled or manual) last ran -- drives "is it due" the same way
    // last_digest_cutoff drives the digest, and distinguishes a flagged-but-in-progress day
    // from one no sync has touched yet.
    mediaSyncAt: timestamp("media_sync_at", { withTimezone: true }),
    // That run's result (a SyncResult, or `{ error }` on an aborted run) -- for the status route.
    mediaSyncResult: jsonb("media_sync_result"),
    // A lease, not a held transaction, protects an in-progress sync (one run can
    // span many ticks/pages). A non-null `media_sync_lease` with `media_sync_lease_until` still
    // in the future means some invocation is actively working it; past that instant, it's
    // abandoned (crashed mid-run) and the next caller takes it over. `media_sync_run_start` and
    // `media_sync_cursor` carry a multi-tick run's own progress across invocations.
    mediaSyncLease: uuid("media_sync_lease"),
    mediaSyncLeaseUntil: timestamp("media_sync_lease_until", { withTimezone: true }),
    mediaSyncRunStart: timestamp("media_sync_run_start", { withTimezone: true }),
    mediaSyncCursor: text("media_sync_cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("nod_settings_singleton", sql`${t.id} = 1`)],
);

export const digestRuns = pgTable("digest_runs", {
  cutoff: timestamp("cutoff", { withTimezone: true }).primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  subscribers: integer("subscribers").notNull().default(0),
  groups: integer("groups").notNull().default(0),
});

/** Staff/operations actions that aren't about one subscriber (pause/resume now; more in 4f). */
export const operationsLog = pgTable("operations_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
});

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

export const LINK_ORIGINS = ["request", "send"] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

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
    // 'request': a subscriber (or staff) explicitly asked for this link — counts toward the
    // 3-per-hour cap (links.ts). 'send': a manage link stamped into an outbound email
    // (Task 3) — doesn't count toward that cap (global constraints: "send links don't count").
    origin: text("origin").$type<LinkOrigin>().notNull().default("request"),
  },
  (t) => [
    index("subscriber_links_email_created_idx").on(t.email, t.createdAt),
    check("subscriber_links_purpose_check", sql`${t.purpose} IN ('verify','manage','change-email')`),
    check("subscriber_links_origin_check", sql`${t.origin} IN ('request','send')`),
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
