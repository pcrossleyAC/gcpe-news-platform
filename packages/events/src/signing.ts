import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(input: {
  secret: string;
  timestamp: string | undefined;
  body: string;
  signature: string | undefined;
  nowMs: number;
  toleranceMs?: number;
}): boolean {
  const { secret, timestamp, body, signature, nowMs, toleranceMs = 300_000 } = input;
  if (!timestamp || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || Math.abs(nowMs - ts) > toleranceMs) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
