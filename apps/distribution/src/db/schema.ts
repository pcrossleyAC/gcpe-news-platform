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
  },
  (t) => [
    index("messages_due_idx").on(t.priority.desc(), t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
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
  },
  (t) => [check("distribution_settings_singleton", sql`${t.id} = 1`)],
);
export type DistributionSettingsRow = typeof distributionSettings.$inferSelect;
