import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { parseEvent } from "./catalogue";

const envelope = (data: unknown) => ({
  id: randomUUID(), type: "delivery.bounced", version: 1, source: "distribution", aggregateId: "message:11111111-1111-1111-1111-111111111111",
  sequence: 1, occurredAt: "2026-10-06T17:00:00Z", correlationId: randomUUID(), data,
});

const valid = {
  appId: "nod",
  batchId: "22222222-2222-2222-2222-222222222222",
  messageId: "11111111-1111-1111-1111-111111111111",
  email: "alex@example.test",
  hard: true,
  status: "5.1.1",
  at: "2026-10-06T17:00:00-07:00",
};

describe("delivery.bounced", () => {
  it("accepts a well-formed event", () => {
    expect(parseEvent(envelope(valid)).data).toEqual(valid);
  });

  it("rejects a batchId that isn't a uuid", () => {
    expect(() => parseEvent(envelope({ ...valid, batchId: "not-a-uuid" }))).toThrow();
  });

  it("rejects a missing hard flag", () => {
    const { hard: _h, ...bad } = valid;
    expect(() => parseEvent(envelope(bad))).toThrow();
  });

  it("rejects an at without an offset", () => {
    expect(() => parseEvent(envelope({ ...valid, at: "2026-10-06T17:00:00" }))).toThrow();
  });
});
