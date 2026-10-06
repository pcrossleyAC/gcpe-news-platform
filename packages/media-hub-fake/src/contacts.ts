/**
 * Deterministic, made-up media contacts for the fake Media Hub (every address and outlet name
 * below is invented and lives under `example.test`, which is reserved for exactly this — RFC
 * 2606 — so no real person or organisation is ever named).
 */

export type FakeEmailKind = "personal" | "workplace";

export interface FakeEmail {
  ref: string;
  address: string;
  kind: FakeEmailKind;
  organization: string | null;
  preferred: boolean;
}

/** Internal record: carries `updatedAt` (never serialised onto the wire contract, which has no
 * such field) so `changes()` can order and filter by it. */
export interface FakeContact {
  id: number;
  firstName: string;
  lastName: string;
  outlet: string | null;
  emails: FakeEmail[];
  deletedAt: string | null;
  updatedAt: string;
}

const FIRST_NAMES = [
  "Alex", "Jordan", "Priya", "Marcus", "Elena", "Sanjay", "Fiona", "Derek", "Nadia", "Oliver",
  "Grace", "Theo", "Mei", "Idris", "Paula", "Victor", "Lena", "Samir", "Ingrid", "Owen",
  "Robin", "Cass", "Noor", "Tomas", "Yuki", "Beth", "Ravi", "Astrid", "Leo", "June",
];

const LAST_NAMES = [
  "Novak", "Byrne", "Okafor", "Lindqvist", "Tanaka", "Alvarez", "Whitfield", "Kowalski", "Reyes", "Bergstrom",
  "Haddad", "Fontaine", "Osei", "Marchetti", "Delgado", "Aoki", "Sorensen", "Petrov", "Nakamura", "Lachance",
];

const OUTLETS = [
  "Capital Ledger", "Pacific Wire News", "Nightly Beacon", "Harborview Gazette", "Summit Press Daily",
  "Coastal Current Media", "Inland Tribune", "Northshore Dispatch", "Frontline Weekly", "Riverbend Times",
  "Granite City Post", "Lakeside Record", "Westgate Chronicle", "Valley Signal News", "Highline Courier",
];

/** A small seeded PRNG (mulberry32) so the same `seed` always produces the same contact set. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Builds `count` deterministic contacts for `seed`: each has one personal email and 1-2
 * workplace emails (one marked `preferred`), under a made-up outlet. `deletedSoFar`
 * soft-deleted contacts are chosen pseudo-randomly from the set (fewest 5, or `count` if
 * smaller). `now` is the initial `updatedAt`/`deletedAt` timestamp for every generated row.
 */
export function generateContacts(opts: { count: number; seed: number; now: string }): FakeContact[] {
  const { count, seed, now } = opts;
  const rng = mulberry32(seed);
  const contacts: FakeContact[] = [];

  for (let id = 1; id <= count; id++) {
    const firstName = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]!;
    const lastName = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]!;
    const outlet = OUTLETS[Math.floor(rng() * OUTLETS.length)]!;
    const workplaceCount = rng() < 0.5 ? 1 : 2;

    const emails: FakeEmail[] = [
      { ref: "personal", address: `${slug(firstName)}.${slug(lastName)}.${id}@example.test`, kind: "personal", organization: null, preferred: false },
    ];
    for (let w = 1; w <= workplaceCount; w++) {
      emails.push({
        ref: `workplace:${w}`,
        address: `${slug(firstName)}.${w}@${slug(outlet)}.example.test`,
        kind: "workplace",
        organization: outlet,
        preferred: w === 1,
      });
    }

    contacts.push({ id, firstName, lastName, outlet, emails, deletedAt: null, updatedAt: now });
  }

  // Fisher-Yates shuffle (same rng stream) to pick which contacts start soft-deleted, so the
  // choice depends on `seed` without favouring the highest ids every time.
  const order = contacts.map((c) => c.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const deletedIds = new Set(order.slice(0, Math.min(5, count)));
  for (const c of contacts) {
    if (deletedIds.has(c.id)) c.deletedAt = now;
  }

  return contacts;
}

/** The public wire shape (Global Constraints §"Media Hub contract") — `updatedAt` is internal
 * only and never appears here. */
export interface PublicContact {
  id: number;
  firstName: string;
  lastName: string;
  outlet: string | null;
  emails: FakeEmail[];
  deletedAt: string | null;
}

export function toPublicContact(c: FakeContact): PublicContact {
  return { id: c.id, firstName: c.firstName, lastName: c.lastName, outlet: c.outlet, emails: c.emails, deletedAt: c.deletedAt };
}
