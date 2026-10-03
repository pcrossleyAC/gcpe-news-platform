import { describe, expect, it } from "vitest";
import { hashPassword, parsePasswordHash, verifyPassword } from "./password";
describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("salts: the same password hashes differently", async () => {
    expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
  });
  it("returns false (does not throw) for malformed stored hashes", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$1$1$$")).toBe(false);
  });

  // Fix round 1, Important #6: scrypt cost parameters themselves are policed, not just the
  // overall shape -- a tampered/corrupted hash with nonsensical N/p must be rejected by the
  // parser itself, before anything ever calls scrypt with those parameters. (A p=2048 hash
  // is *not* rejected by Node's own scrypt — confirmed by hand, it happily runs for ~34s at
  // p=2048/N=16384/r=8 before returning a result — so this has to be caught up front, not
  // left to "scrypt will error out for us".)
  describe("rejects out-of-bounds scrypt parameters", () => {
    it("parsePasswordHash rejects N that isn't a power of two at all (e.g. scrypt$3$...)", async () => {
      const real = await hashPassword("whatever");
      const parts = real.split("$");
      parts[1] = "3";
      expect(parsePasswordHash(parts.join("$"))).toBeNull();
    });
    it("parsePasswordHash rejects N below the policy minimum, even though it's a valid power of two for scrypt itself", async () => {
      const real = await hashPassword("whatever");
      const parts = real.split("$");
      parts[1] = String(2 ** 13); // half the 2^14 minimum; still a legal scrypt N
      const tooWeak = parts.join("$");
      expect(parsePasswordHash(tooWeak)).toBeNull();
      // End-to-end through verifyPassword too -- N=2^13 is cheap enough that this stays fast.
      expect(await verifyPassword("whatever", tooWeak)).toBe(false);
    });
    it("parsePasswordHash rejects p beyond the allowed range (e.g. p=2048) without ever calling scrypt", async () => {
      const real = await hashPassword("whatever");
      const parts = real.split("$");
      parts[3] = "2048";
      expect(parsePasswordHash(parts.join("$"))).toBeNull();
    });
  });
});
