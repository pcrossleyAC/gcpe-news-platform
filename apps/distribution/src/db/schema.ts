import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export * from "@gcpe/events/tables";

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
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    originalRecipient: text("original_recipient"),
  },
  (t) => [
    index("messages_due_idx").on(t.priority.desc(), t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    check("messages_status_check", sql`${t.status} IN ('pending','sent','failed')`),
  ],
);
export type MessageRow = typeof messages.$inferSelect;
