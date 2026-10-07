import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export * from "@gcpe/events/tables";

/** A batch attachment as posted (base64 content), sent unchanged with every message. */
export interface StoredAttachment {
  filename: string;
  contentType: "application/pdf" | "text/plain";
  contentBase64: string;
}

export type MessageStatus = "pending" | "sent" | "failed";

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: text("app_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    subject: text("subject"),
    html: text("html"),
    text: text("text"),
    headers: jsonb("headers").$type<Record<string, string>>(),
    attachments: jsonb("attachments").$type<StoredAttachment[]>().notNull().default([]),
    // The request's Reply-To, if any — read back at send time (sender.ts) and used ahead of
    // MAIL_REPLY_TO.
    replyTo: text("reply_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("batches_app_id_idempotency_key_idx").on(t.appId, t.idempotencyKey)],
);
export type BatchRow = typeof batches.$inferSelect;

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    substitutions: jsonb("substitutions").$type<Record<string, string>>(),
    priority: integer("priority").notNull(),
    status: text("status").$type<MessageStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // R1(c): a config-class error (the worker's own SMTP setup is suspected, not this
    // message) defers without spending an `attempts` — tracked separately so its own backoff
    // can still escalate (capped at 1h) without ever moving this message toward MAX_ATTEMPTS.
    deferrals: integer("deferrals").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    originalRecipient: text("original_recipient"),
    // Set when a send is attempted (sender.ts, in the same update that re-asserts the row's
    // lock) and stable across retries of the same row — 4e matches bounces by it.
    messageId: text("message_id"),
    // 4e: set by bounces/store.ts's recordBounce, from the matched bounce. Left untouched by a
    // later bounce once bounceHard is true — a hard bounce is never downgraded back to soft.
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    bounceStatus: text("bounce_status"),
    bounceHard: boolean("bounce_hard"),
  },
  (t) => [
    index("messages_due_idx").on(t.priority.desc(), t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    // bounces/store.ts's recipient fallback: the most recent `sent` message to a recipient
    // (case-insensitively), within a few days -- without this, that lookup falls back to a
    // sequential scan on any table of real size.
    index("messages_sent_email_lower_idx").on(sql`lower(${t.email})`, t.sentAt).where(sql`${t.status} = 'sent'`),
    check("messages_status_check", sql`${t.status} IN ('pending','sent','failed')`),
  ],
);
export type MessageRow = typeof messages.$inferSelect;

// The database-enforced per-minute send cap (sender.ts): one row per minute, holding how many
// messages have been claimed in that minute across every worker. The claim transaction locks
// this row (SELECT ... FOR UPDATE) before claiming any message row, so concurrent workers
// serialise on it rather than on the messages table.
export const sendRateWindows = pgTable("send_rate_windows", {
  windowStart: timestamp("window_start", { withTimezone: true }).primaryKey(),
  claimed: integer("claimed").notNull().default(0),
});
export type SendRateWindowRow = typeof sendRateWindows.$inferSelect;

// The Distribution-wide pause switch (spec §6/§8): a singleton row, staff-controlled through
// NoD's admin (NoD.Admin), read by sender.ts's claim every run. Mirrors nod_settings' own
// singleton pattern (apps/nod/src/db/schema.ts).
export const distributionSettings = pgTable(
  "distribution_settings",
  {
    id: integer("id").primaryKey().default(1),
    paused: boolean("paused").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // 4e: the 15-minute bounce run's own gate (bounces/run.ts's runBouncesIfDue) — null means
    // never checked. Set, inside the same short transaction that reads it, by the run that
    // claims the gate; read by database `now()` only, never a JS clock.
    bouncesCheckedAt: timestamp("bounces_checked_at", { withTimezone: true }),
  },
  (t) => [check("distribution_settings_singleton", sql`${t.id} = 1`)],
);
export type DistributionSettingsRow = typeof distributionSettings.$inferSelect;

// 4e: the fake bounce source's own mailbox (bounces/source.ts's fakeBounceSource) — rows
// posted through the Distribution.Operate-gated /api/bounces/inbox route (fake mode only), read
// FIFO where `processed_at IS NULL`, and marked processed once fetched (bounces/run.ts marks
// every fetched row processed, never re-reading one). Never used when BOUNCE_SOURCE=graph.
export const bounceInbox = pgTable(
  "bounce_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    raw: text("raw").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("bounce_inbox_unprocessed_idx").on(t.receivedAt).where(sql`${t.processedAt} IS NULL`)],
);
export type BounceInboxRow = typeof bounceInbox.$inferSelect;

export type BounceKind = "bounce" | "ignored";
export type BounceMethod = "rfc3464" | "heuristic";

// 4e: one row per bounce report fetched from the bounce source (fake or Graph), keyed by that
// source's own id so re-fetching the same message (the source is polled, not drained) never
// double-processes it. The raw message is kept here only — never logged — as evidence.
export const bounces = pgTable(
  "bounces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    raw: text("raw").notNull(),
    kind: text("kind").$type<BounceKind>().notNull(),
    recipient: text("recipient"),
    status: text("status"),
    hard: boolean("hard"),
    method: text("method").$type<BounceMethod>(),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    matched: boolean("matched").notNull().default(false),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("bounces_source_id_idx").on(t.sourceId), check("bounces_kind_check", sql`${t.kind} IN ('bounce','ignored')`)],
);
export type BounceRow = typeof bounces.$inferSelect;
