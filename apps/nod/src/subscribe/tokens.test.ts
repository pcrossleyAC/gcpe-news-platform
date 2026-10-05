import { describe, expect, it } from "vitest";
import { hashToken, newLinkToken, parseUnsubscribeToken, unsubscribeToken } from "./tokens";

const SECRET = "s".repeat(32);
const ID = "3f1c2e4a-1b2c-4d5e-8f90-123456789abc";

describe("tokens", () => {
  it("link tokens are 43-char base64url and differ every time", () => {
    const a = newLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newLinkToken()).not.toBe(a);
  });
  it("hashToken is stable hex sha-256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("an unsubscribe token round-trips and names its subscriber and version", () => {
    expect(parseUnsubscribeToken(SECRET, unsubscribeToken(SECRET, ID, 2))).toEqual({ subscriberId: ID, version: 2 });
  });
  it("rejects a tampered, foreign-secret or malformed unsubscribe token", () => {
    const t = unsubscribeToken(SECRET, ID, 1);
    expect(parseUnsubscribeToken(SECRET, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(parseUnsubscribeToken("x".repeat(32), t)).toBeNull();
    expect(parseUnsubscribeToken(SECRET, "pat@example.com")).toBeNull();
    expect(parseUnsubscribeToken(SECRET, "")).toBeNull();
  });
});
