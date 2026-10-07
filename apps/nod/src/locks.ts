import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";

/** Advisory-lock keyspace shared by every module that reads or writes a `subscribers` row by
 * address -- the public journeys (subscribe/journeys.ts), staff media-list membership
 * (media-members.ts) and the bounce threshold (bounces.ts) all take this lock, on the same
 * lowercased email, before reading that row `FOR UPDATE`. Serialises them against each other
 * so e.g. a bounce threshold write can never read a stale pre-unsubscribe row, and vice versa.
 * Released automatically at transaction end. */
export async function lockAddress(tx: DbOrTx, email: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${email}))`);
}
