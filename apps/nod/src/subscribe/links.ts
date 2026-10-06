import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { subscriberLinks, type LinkPurpose, type SubscriberPrefs } from "../db/schema";
import { hashToken, newLinkToken } from "./tokens";

export const LINK_TTL_MS = 24 * 3_600_000;
export const MAX_EMAILS_PER_HOUR = 3;
export type LinkRow = typeof subscriberLinks.$inferSelect & { expired: boolean };

export async function createLink(
  tx: DbOrTx,
  input: { purpose: LinkPurpose; email: string; subscriberId: string | null; pending: SubscriberPrefs | null },
): Promise<{ id: string; token: string }> {
  const token = newLinkToken();
  const [row] = await tx
    .insert(subscriberLinks)
    .values({
      tokenHash: hashToken(token),
      purpose: input.purpose,
      email: input.email.trim().toLowerCase(),
      subscriberId: input.subscriberId,
      pending: input.pending,
      expiresAt: sql`now() + make_interval(secs => ${LINK_TTL_MS / 1000})`,
    })
    .returning({ id: subscriberLinks.id });
  return { id: row!.id, token };
}

export async function findLink(db: DbOrTx, token: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db
    .select({ link: subscriberLinks, expired: sql<boolean>`${subscriberLinks.expiresAt} <= now()` })
    .from(subscriberLinks)
    .where(eq(subscriberLinks.tokenHash, hashToken(token)));
  return row ? { ...row.link, expired: row.expired } : null;
}

export async function markLinkUsed(tx: DbOrTx, id: string): Promise<void> {
  await tx.update(subscriberLinks).set({ usedAt: sql`now()` }).where(eq(subscriberLinks.id, id));
}

/** Atomically claims a one-time link: marks it used only if it hadn't been already, and reports
 * whether this call won that race. Two concurrent (or repeated) attempts to apply the same link
 * must result in exactly one of them doing the work — this is the guard. */
export async function claimLink(tx: DbOrTx, id: string): Promise<boolean> {
  const r = await tx.execute<{ id: string }>(sql`
    UPDATE ${subscriberLinks} SET used_at = now() WHERE id = ${id} AND used_at IS NULL RETURNING id`);
  return r.rows.length > 0;
}

export async function linksSentLastHour(db: DbOrTx, email: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${subscriberLinks}
     WHERE ${subscriberLinks.email} = ${email.trim().toLowerCase()} AND ${subscriberLinks.createdAt} > now() - interval '1 hour'`);
  return r.rows[0]!.n;
}
