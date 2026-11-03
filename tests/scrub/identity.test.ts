import { describe, expect, it } from "vitest";
import { CAPACITY, createIdentityAllocator, FAKE_PHONE, fakeEmailFor, fakePhone, identityAt } from "../../scripts/lib/scrub/identity";
import { FIRST_NAMES, SURNAMES } from "../../scripts/lib/scrub/names";

const KEY = "a".repeat(64);
const none = { forbiddenNames: new Set<string>(), reservedEmails: new Set<string>() };

describe("fictional identities", () => {
  it("gives the same identity to the same person for the same key and order", () => {
    const a = createIdentityAllocator(KEY, none);
    const b = createIdentityAllocator(KEY, none);
    expect(a.allocate("e:quill.ashbury@gov.example")).toEqual(b.allocate("e:quill.ashbury@gov.example"));
  });

  it("gives different people different identities", () => {
    const a = createIdentityAllocator(KEY, none);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(a.allocate(`n:person ${i}`).full);
    expect(seen.size).toBe(2000);
  });

  it("depends on the key", () => {
    const p = "e:quill.ashbury@gov.example";
    expect(createIdentityAllocator(KEY, none).allocate(p).slot).not.toBe(createIdentityAllocator("b".repeat(64), none).allocate(p).slot);
  });

  it("never hands out a forbidden name or a reserved email", () => {
    const first = createIdentityAllocator(KEY, none).allocate("n:quill ashbury");
    const guarded = createIdentityAllocator(KEY, { forbiddenNames: new Set([first.full.toLowerCase()]), reservedEmails: new Set() }).allocate("n:quill ashbury");
    expect(guarded.full).not.toBe(first.full);
    const reserved = createIdentityAllocator(KEY, { forbiddenNames: new Set(), reservedEmails: new Set([first.email]) }).allocate("n:quill ashbury");
    expect(reserved.email).not.toBe(first.email);
  });

  it("fits every identity into legacy's shortest columns", () => {
    let full = 0, email = 0, username = 0;
    for (let slot = 0; slot < CAPACITY; slot++) {
      const id = identityAt(slot);
      full = Math.max(full, id.full.length); email = Math.max(email, id.email.length); username = Math.max(username, id.username.length);
    }
    expect(full).toBeLessThanOrEqual(50);
    expect(email).toBeLessThanOrEqual(50);
    expect(username).toBeLessThanOrEqual(20);
    expect(CAPACITY).toBeGreaterThanOrEqual(20_000);
  });

  it("makes example.test emails and 555-01xx phones", () => {
    const id = createIdentityAllocator(KEY, none).allocate("n:quill ashbury");
    expect(id.email).toMatch(/^[a-z]+\.[a-z]+@example\.test$/);
    expect(id.phone).toMatch(FAKE_PHONE);
    expect(fakePhone(KEY, "6045550142")).toMatch(/^250-555-01\d\d$/);
    expect(fakePhone(KEY, "6045550142")).toBe(fakePhone(KEY, "6045550142"));
    expect(fakeEmailFor(KEY, "Press@News.Example")).toBe(fakeEmailFor(KEY, "press@news.example"));
    expect(fakeEmailFor(KEY, "press@news.example")).toMatch(/^person\d{1,6}@example\.test$/);
  });

  it("uses only letters in names", () => {
    for (const n of [...FIRST_NAMES, ...SURNAMES]) expect(n).toMatch(/^[A-Z][a-z]+$/);
  });
});
