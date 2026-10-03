import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "./signing";

const secret = "s3cret";
const ts = "2026-10-02T17:00:00.000Z";
const nowMs = Date.parse(ts);

describe("signing", () => {
  it("verifies its own signature", () => {
    const sig = signPayload(secret, ts, '{"a":1}');
    expect(verifySignature({ secret, timestamp: ts, body: '{"a":1}', signature: sig, nowMs })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signPayload(secret, ts, '{"a":1}');
    expect(verifySignature({ secret, timestamp: ts, body: '{"a":2}', signature: sig, nowMs })).toBe(false);
  });

  it("rejects a timestamp older than five minutes", () => {
    const sig = signPayload(secret, ts, "{}");
    expect(verifySignature({ secret, timestamp: ts, body: "{}", signature: sig, nowMs: nowMs + 300_001 })).toBe(false);
  });

  it("rejects missing headers and non-hex signatures", () => {
    expect(verifySignature({ secret, timestamp: undefined, body: "{}", signature: "ab", nowMs })).toBe(false);
    expect(verifySignature({ secret, timestamp: ts, body: "{}", signature: "zz-not-hex", nowMs })).toBe(false);
  });
});
