import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { mediaOptOuts, type SubscriberRow } from "./db/schema";
import { normaliseEmail } from "./subscribe/info";

/**
 * The key a media-list opt-out is kept under once the subscriber row is purged: SHA-256 of the
 * lowercased address under a fixed prefix. Unkeyed on purpose: rotating LINK_SECRET (the
 * response to a leaked unsubscribe token) must never forget anyone's opt-out.
 */
export function optOutHash(email: string): string {
  return createHash("sha256").update(`gcpe-nod-media-opt-out:${normaliseEmail(email)}`).digest("hex");
}

/** Copies the subscriber's media-list opt-outs (latest per list) into media_opt_outs. Called
 * inside the purge's per-subscriber transaction, just before the row is deleted. */
export async function keepMediaOptOuts(tx: DbOrTx, s: Pick<SubscriberRow, "id" | "email">): Promise<number> {
  const res = await tx.execute(sql`
    INSERT INTO ${mediaOptOuts} (email_hash, list_key, opted_out_at)
    SELECT ${optOutHash(s.email)}, detail, max(at) FROM subscriber_history
     WHERE subscriber_id = ${s.id} AND action = 'media-list-opted-out'
     GROUP BY detail
    ON CONFLICT (email_hash, list_key) DO UPDATE SET opted_out_at = GREATEST(${mediaOptOuts.optedOutAt}, EXCLUDED.opted_out_at)`);
  return res.rowCount ?? 0;
}

export async function suppressedOptOutAt(tx: DbOrTx, email: string, listKey: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: mediaOptOuts.optedOutAt })
    .from(mediaOptOuts)
    .where(and(eq(mediaOptOuts.emailHash, optOutHash(email)), eq(mediaOptOuts.listKey, listKey)));
  return row?.at ?? null;
}
