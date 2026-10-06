import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  sequence: integer("sequence").notNull(),
  envelope: jsonb("envelope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outboxDeliveries = pgTable(
  "outbox_deliveries",
  {
    eventId: uuid("event_id").notNull().references(() => outboxEvents.id, { onDelete: "cascade" }),
    subscriber: text("subscriber").notNull(),
    status: text("status").notNull().default("pending"), // pending | delivered | dead
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.subscriber] }), index("outbox_deliveries_due_idx").on(t.status, t.nextAttemptAt)],
);

export const aggregateSequences = pgTable("aggregate_sequences", {
  aggregateId: text("aggregate_id").primaryKey(),
  lastSequence: integer("last_sequence").notNull(),
});

export const inboxEvents = pgTable("inbox_events", {
  eventId: uuid("event_id").primaryKey(),
  source: text("source").notNull(),
  type: text("type").notNull(),
  outcome: text("outcome").notNull(), // applied | ignored | stale
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxPositions = pgTable(
  "inbox_positions",
  {
    source: text("source").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    lastSequence: integer("last_sequence").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.aggregateId] })],
);
