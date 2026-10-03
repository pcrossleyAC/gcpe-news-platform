import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// The event receiver (mounted in app.ts) needs inbox_events/inbox_positions to exist in this
// app's own database, same as every other app that receives signed events.
export * from "@gcpe/events/tables";

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
  },
  (t) => [uniqueIndex("subscribers_email_lower_idx").on(sql`lower(${t.email})`)],
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
    asItHappens: boolean("as_it_happens").notNull().default(true),
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
