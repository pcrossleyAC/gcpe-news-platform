import express from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import { parseEvent } from "./catalogue";
import { MAX_EVENT_BYTES, type EventEnvelope } from "./envelope";
import { verifySignature } from "./signing";
import { inboxEvents, inboxPositions } from "./tables";

export type EventHandler = (tx: Tx, event: EventEnvelope) => Promise<void>;

export interface ReceiverOptions {
  db: Db;
  secrets: Record<string, string>;
  handlers: Record<string, EventHandler>;
  now?: () => number;
  onApplied?: (event: EventEnvelope) => void | Promise<void>;
}

type Outcome = "applied" | "ignored" | "stale" | "duplicate";

export function createEventReceiver(opts: ReceiverOptions): express.Router {
  const router = express.Router();
  router.post("/events", express.text({ type: "application/json", limit: MAX_EVENT_BYTES }), async (req, res) => {
    const body = typeof req.body === "string" ? req.body : "";
    const source = req.header("x-event-source");
    const secret = source && Object.hasOwn(opts.secrets, source) ? opts.secrets[source] : undefined;
    const valid =
      typeof secret === "string" &&
      verifySignature({
        secret,
        timestamp: req.header("x-event-timestamp"),
        body,
        signature: req.header("x-signature"),
        nowMs: (opts.now ?? Date.now)(),
      });
    if (!valid) return void res.status(401).json({ error: "invalid signature" });

    let event: EventEnvelope;
    try {
      event = parseEvent(JSON.parse(body));
    } catch {
      return void res.status(400).json({ error: "invalid event" });
    }
    if (event.source !== source) return void res.status(400).json({ error: "source mismatch" });

    try {
      const outcome = await opts.db.transaction(async (tx): Promise<Outcome> => {
        const inserted = await tx
          .insert(inboxEvents)
          .values({ eventId: event.id, source: event.source, type: event.type, outcome: "pending" })
          .onConflictDoNothing()
          .returning({ id: inboxEvents.eventId });
        if (inserted.length === 0) return "duplicate";

        // Ensure a position row exists before locking it: a bare SELECT ... FOR UPDATE
        // locks nothing when no row exists yet, so two concurrent first-ever events for
        // the same aggregate would both read "no prior position" and both apply out of
        // order. Sequences start at 1, so lastSequence 0 means "no prior events".
        await tx
          .insert(inboxPositions)
          .values({ source: event.source, aggregateId: event.aggregateId, lastSequence: 0 })
          .onConflictDoNothing();

        const [pos] = await tx
          .select()
          .from(inboxPositions)
          .where(and(eq(inboxPositions.source, event.source), eq(inboxPositions.aggregateId, event.aggregateId)))
          .for("update");

        let outcome: Outcome;
        if (pos && event.sequence <= pos.lastSequence) {
          outcome = "stale";
        } else {
          const handler = opts.handlers[event.type];
          if (handler) await handler(tx, event);
          outcome = handler ? "applied" : "ignored";
          await tx
            .insert(inboxPositions)
            .values({ source: event.source, aggregateId: event.aggregateId, lastSequence: event.sequence })
            .onConflictDoUpdate({
              target: [inboxPositions.source, inboxPositions.aggregateId],
              set: { lastSequence: sql`greatest(${inboxPositions.lastSequence}, excluded.last_sequence)` },
            });
        }
        await tx.update(inboxEvents).set({ outcome }).where(eq(inboxEvents.eventId, event.id));
        return outcome;
      });
      if (outcome === "applied" && opts.onApplied) {
        try {
          await opts.onApplied(event);
        } catch (e) {
          console.error("[events] onApplied failed", event.type, event.id, e);
        }
      }
      res.status(200).json({ outcome });
    } catch (e) {
      console.error("[events] handler failed", event.type, event.id, e);
      res.status(500).json({ error: "handler failed" });
    }
  });
  return router;
}
