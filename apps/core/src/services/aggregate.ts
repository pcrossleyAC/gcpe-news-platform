import { sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import type { TermKind } from "@gcpe/events";

/** The `source` Core stamps on every event it publishes. */
export const CORE_SOURCE = "core";

export function orgAggregateId(key: string): string {
  return `org:${key}`;
}

export function userAggregateId(id: string): string {
  return `user:${id}`;
}

export function termAggregateId(kind: TermKind, key: string): string {
  return `${kind}:${key}`;
}

/**
 * Serialises every write and republish of one aggregate for the rest of the transaction,
 * so the order of outbox sequences matches the order of committed changes.
 */
export async function lockAggregate(tx: Tx, aggregateId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${aggregateId}))`);
}
