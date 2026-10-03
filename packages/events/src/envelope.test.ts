import { describe, expect, it } from "vitest";
import { assertEventFits, envelopeByteLength, EventTooLargeError, MAX_EVENT_BYTES, MAX_SEQUENCE, sizingEnvelope, type EventEnvelope } from "./envelope";

const base: EventEnvelope = {
  id: "9af8cc16-0ae5-4ec6-ad58-fdb081d44e37",
  type: "org.deactivated",
  version: 1,
  source: "core",
  aggregateId: "org:x",
  sequence: 1,
  occurredAt: "2026-10-03T17:00:00.000Z",
  correlationId: "1af8cc16-0ae5-4ec6-ad58-fdb081d44e37",
  data: { key: "x" },
};

describe("envelope sizing", () => {
  it("envelopeByteLength counts UTF-8 bytes of the serialised envelope", () => {
    const ascii = envelopeByteLength(base);
    expect(ascii).toBe(Buffer.byteLength(JSON.stringify(base), "utf8"));
    // "é" is one UTF-16 unit but two UTF-8 bytes.
    expect(envelopeByteLength({ ...base, data: { key: "é" } })).toBe(ascii + 1);
  });

  it("assertEventFits accepts an envelope at the limit and rejects one byte over", () => {
    const overhead = envelopeByteLength({ ...base, data: { key: "" } });
    const atLimit = { ...base, data: { key: "x".repeat(MAX_EVENT_BYTES - overhead) } };
    expect(envelopeByteLength(atLimit)).toBe(MAX_EVENT_BYTES);
    expect(() => assertEventFits(atLimit)).not.toThrow();
    const over = { ...base, data: { key: "x".repeat(MAX_EVENT_BYTES - overhead + 1) } };
    expect(() => assertEventFits(over)).toThrow(EventTooLargeError);
  });

  it("sizingEnvelope sizes the not-yet-assigned sequence at its maximum width, every other generated field at its real width", () => {
    const sized = sizingEnvelope({ type: base.type, source: base.source, aggregateId: base.aggregateId, data: base.data });
    expect(sized.sequence).toBe(MAX_SEQUENCE);
    expect(String(MAX_SEQUENCE)).toHaveLength(10);
    // A real envelope (random UUIDs, a current timestamp) at the largest sequence is exactly as long.
    const real: EventEnvelope = { ...base, id: crypto.randomUUID(), correlationId: crypto.randomUUID(), occurredAt: new Date().toISOString(), sequence: MAX_SEQUENCE };
    expect(envelopeByteLength(sized)).toBe(envelopeByteLength(real));
    expect(envelopeByteLength(sized)).toBe(envelopeByteLength(base) + 9);
  });
});
