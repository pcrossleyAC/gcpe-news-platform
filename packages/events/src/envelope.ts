import { z } from "zod";

export const eventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  source: z.string().min(1),
  aggregateId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: z.string().uuid(),
  data: z.unknown(),
});

export type EventEnvelope<T = unknown> = Omit<z.infer<typeof eventEnvelopeSchema>, "data"> & { data: T };

/**
 * Largest serialised envelope a producer may enqueue and a receiver will accept, in bytes.
 * Producers and receivers share this constant so an event that was accepted for the outbox
 * can always be delivered.
 */
export const MAX_EVENT_BYTES = 1_000_000;

export class EventTooLargeError extends Error {
  constructor(
    readonly type: string,
    readonly aggregateId: string,
    readonly bytes: number,
  ) {
    super(`event ${type} for ${aggregateId} is ${bytes} bytes; the limit is MAX_EVENT_BYTES (${MAX_EVENT_BYTES})`);
    this.name = "EventTooLargeError";
  }
}
