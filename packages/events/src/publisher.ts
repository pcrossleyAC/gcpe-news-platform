import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { parseEvent } from "./catalogue";
import { assertEventFits, type EventEnvelope } from "./envelope";
import { subscribersFor, type SubscriberConfig } from "./subscribers";
import { aggregateSequences, outboxDeliveries, outboxEvents } from "./tables";

export async function enqueueEvent(
  tx: DbOrTx,
  input: { type: string; source: string; aggregateId: string; data: unknown; correlationId?: string; version?: number },
  subscribers: SubscriberConfig[],
): Promise<EventEnvelope> {
  const [seq] = await tx
    .insert(aggregateSequences)
    .values({ aggregateId: input.aggregateId, lastSequence: 1 })
    .onConflictDoUpdate({
      target: aggregateSequences.aggregateId,
      set: { lastSequence: sql`${aggregateSequences.lastSequence} + 1` },
    })
    .returning({ lastSequence: aggregateSequences.lastSequence });

  const envelope = parseEvent({
    id: randomUUID(),
    type: input.type,
    version: input.version ?? 1,
    source: input.source,
    aggregateId: input.aggregateId,
    sequence: seq!.lastSequence,
    occurredAt: new Date().toISOString(),
    correlationId: input.correlationId ?? randomUUID(),
    data: input.data,
  });
  assertEventFits(envelope);

  await tx.insert(outboxEvents).values({
    id: envelope.id,
    type: envelope.type,
    aggregateId: envelope.aggregateId,
    sequence: envelope.sequence,
    envelope,
  });
  const targets = subscribersFor(envelope.type, subscribers);
  if (targets.length > 0) {
    await tx.insert(outboxDeliveries).values(targets.map((s) => ({ eventId: envelope.id, subscriber: s.name })));
  }
  return envelope;
}
