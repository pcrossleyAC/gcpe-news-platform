import { createHmac } from "node:crypto";
import { FIRST_NAMES, SURNAMES } from "./names";

export interface FakeIdentity { slot: number; first: string; last: string; full: string; email: string; phone: string; username: string }

export const CAPACITY = FIRST_NAMES.length * SURNAMES.length;
/** What the scrubber writes, so a second pass leaves it alone and the gates accept it. */
export const FAKE_PHONE = /^(?:250-)?555-01\d\d$/;
/** The digits of a fictional number: 250 555 01xx, or the local 555 01xx. */
export const FAKE_DIGITS = /^(?:250)?55501\d\d$/;
/**
 * A fictional number however it is laid out: its digits, without an extension or a leading 1, are in the fictional
 * range ("250 555-0142", "1 250-555-0142", "250-555-0142 ext 1234").
 */
export function isFakePhone(value: string): boolean {
  let d = value.replace(/\s*(?:ext\.?|extension|x)\s*\d{1,6}\s*$/i, "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return FAKE_DIGITS.test(d);
}

export function hmacInt(key: string, value: string): number {
  return createHmac("sha256", key).update(value).digest().readUIntBE(0, 6);
}

export function fakePhone(key: string, seed: string): string {
  return `250-555-01${String(hmacInt(key, `phone:${seed}`) % 100).padStart(2, "0")}`;
}

export function fakeEmailFor(key: string, email: string): string {
  return `person${hmacInt(key, `email:${email.toLowerCase()}`) % 1_000_000}@example.test`;
}

export function identityAt(slot: number): Omit<FakeIdentity, "phone"> {
  const first = FIRST_NAMES[slot % FIRST_NAMES.length]!;
  const last = SURNAMES[Math.floor(slot / FIRST_NAMES.length) % SURNAMES.length]!;
  return { slot, first, last, full: `${first} ${last}`, email: `${first}.${last}@example.test`.toLowerCase(), username: `user${String(slot).padStart(5, "0")}` };
}

export interface IdentityAllocator { allocate(personKey: string): FakeIdentity }

/**
 * Each person starts at a keyed slot and probes forward past slots already taken, names that
 * belong to a real person in the people list, and emails a carried-over test account uses.
 * Allocating people in a stable order therefore gives the same identities on every run.
 */
export function createIdentityAllocator(key: string, o: { forbiddenNames: ReadonlySet<string>; reservedEmails: ReadonlySet<string> }): IdentityAllocator {
  const used = new Set<number>();
  return {
    allocate(personKey) {
      const start = hmacInt(key, `person:${personKey}`) % CAPACITY;
      for (let i = 0; i < CAPACITY; i++) {
        const slot = (start + i) % CAPACITY;
        if (used.has(slot)) continue;
        const id = identityAt(slot);
        if (o.forbiddenNames.has(id.full.toLowerCase()) || o.reservedEmails.has(id.email)) continue;
        used.add(slot);
        return { ...id, phone: fakePhone(key, `person:${personKey}`) };
      }
      throw new Error("ran out of fictional identities");
    },
  };
}
