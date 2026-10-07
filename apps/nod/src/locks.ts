import { eq, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { subscribers, type SubscriberRow } from "./db/schema";
import { normaliseEmail } from "./subscribe/info";

/** Advisory-lock keyspace shared by every module that reads or writes a `subscribers` row by
 * address -- the public journeys (subscribe/journeys.ts), staff media-list membership
 * (media-members.ts), the nightly Media Hub sync (media-hub/sync.ts) and the bounce threshold
 * (bounces.ts) all take this lock, on the same lowercased email, before reading that row `FOR
 * UPDATE`. Serialises them against each other so e.g. a bounce threshold write can never read
 * a stale pre-unsubscribe row, and vice versa. Released automatically at transaction end. */
export async function lockAddress(tx: DbOrTx, email: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${email}))`);
}

/** The row's address changed between the unlocked read and the lock being granted, on every
 * attempt. Carries no address: it can reach an error handler that logs the whole error. */
export class AddressMovedError extends Error {
  constructor() { super("subscriber address changed while waiting for its lock"); }
}
const LOCK_ATTEMPTS = 3;

/**
 * Runs `work` in a transaction holding the subscriber's address lock (plus `alsoLock`, for a
 * change of email), all taken in sorted order before the row is read FOR UPDATE, so two
 * writers can never wait on each other's locks. The address to lock is learned from an
 * unlocked read; if it has moved by the time the lock is held, the transaction is rolled back
 * and retried against the new address rather than going ahead under the wrong lock or taking
 * a second lock out of order. `work` gets `null` when no such subscriber exists.
 */
export async function withLockedSubscriber<T>(
  db: Db,
  id: string,
  alsoLock: string | null,
  work: (tx: Tx, s: SubscriberRow | null) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const [before] = await db.select({ email: subscribers.email }).from(subscribers).where(eq(subscribers.id, id));
    const address = before ? normaliseEmail(before.email) : null;
    try {
      return await db.transaction(async (tx) => {
        const toLock = [address, alsoLock].filter((a): a is string => a !== null);
        for (const a of [...new Set(toLock)].sort()) await lockAddress(tx, a);
        const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, id)).for("update");
        if (s && normaliseEmail(s.email) !== address) throw new AddressMovedError();
        return work(tx, s ?? null);
      });
    } catch (e) {
      if (e instanceof AddressMovedError && attempt < LOCK_ATTEMPTS) continue;
      throw e;
    }
  }
}
