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

/** Largest sequence an aggregate can reach: aggregate_sequences.last_sequence is a Postgres
 * `integer`. Used to size an event before its real sequence is assigned (see
 * {@link sizingEnvelope}). */
export const MAX_SEQUENCE = 2_147_483_647;

/** Bytes `envelope` serialises to — exactly what the outbox stores and the dispatcher POSTs. */
export function envelopeByteLength(envelope: EventEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

/** Throws {@link EventTooLargeError} when `envelope` serialises to more than
 * {@link MAX_EVENT_BYTES}. */
export function assertEventFits(envelope: EventEnvelope): void {
  const bytes = envelopeByteLength(envelope);
  if (bytes > MAX_EVENT_BYTES) throw new EventTooLargeError(envelope.type, envelope.aggregateId, bytes);
}

/**
 * The largest envelope `input` can become once enqueued, for checking size *before* the event
 * exists (e.g. when a draft is saved, long before it's published). Generated fields are
 * fixed-width placeholders at their real width — the event `id` is a UUID (36 characters), an
 * ISO `occurredAt` is always 24 — and the sequence, which isn't known yet, is sized at
 * {@link MAX_SEQUENCE} (10 digits): the explicit margin that keeps an event accepted here from
 * failing enqueueEvent's own check later just because its aggregate's sequence grew.
 *
 * `correlationId`: sized with the caller's actual value when one is given (it is copied into
 * the envelope as-is), otherwise as the 36-character UUID enqueueEvent generates. Assumes the
 * caller passes the same correlationId (or none) to enqueueEvent later.
 */
export function sizingEnvelope(input: { type: string; source: string; aggregateId: string; data: unknown; version?: number; correlationId?: string }): EventEnvelope {
  const placeholderUuid = "00000000-0000-0000-0000-000000000000";
  return {
    id: placeholderUuid,
    type: input.type,
    version: input.version ?? 1,
    source: input.source,
    aggregateId: input.aggregateId,
    sequence: MAX_SEQUENCE,
    occurredAt: new Date(0).toISOString(),
    correlationId: input.correlationId ?? placeholderUuid,
    data: input.data,
  };
}
