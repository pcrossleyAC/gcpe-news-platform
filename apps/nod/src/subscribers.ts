import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { subscribers, subscriptions } from "./db/schema";
import { matchesItem } from "./matching";

/** Thrown by {@link addSubscriber} on a case-insensitive email clash (subscribers_email_lower_idx). */
export class SubscriberExistsError extends Error {}

export interface AddSubscriberInput {
  email: string;
  /** "all" subscribes to every list ('*'); otherwise one or more index keys (e.g. "ministries:Health"). */
  lists: string[] | "all";
}

/**
 * Phase 2 ruling: subscribers are added already verified through the admin API, standing in
 * for the double opt-in journey (Phase 4's public Subscribe API) — so this sets verifiedAt
 * immediately and goes straight to `status: "active"` (source `"admin"`), skipping the
 * pending/verify-link step a self-service signup goes through.
 * List keys are lowercased here (the receiver compares against indexKeysFor's lowercased
 * output); validating their shape ('<kind>:<key>') is the HTTP layer's job (routes.ts).
 * Deduped after lowercasing: two input keys that only differ by casing (e.g.
 * "ministries:Health" and "ministries:health") would otherwise collide on the
 * (subscriberId, listKey) primary key mid-insert.
 */
export async function addSubscriber(db: Db, input: AddSubscriberInput): Promise<{ id: string }> {
  const listKeys = input.lists === "all" ? ["*"] : [...new Set(input.lists.map((key) => key.toLowerCase()))];
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(subscribers)
        .values({ email: input.email, verifiedAt: new Date(), status: "active", source: "admin", asItHappens: true })
        .returning({ id: subscribers.id });
      const subscriberId = row!.id;
      if (listKeys.length > 0) {
        await tx.insert(subscriptions).values(listKeys.map((listKey) => ({ subscriberId, listKey })));
      }
      return { id: subscriberId };
    });
  } catch (e) {
    // drizzle-orm's shared pg-core session wraps every driver error in a DrizzleQueryError,
    // putting the original pg error (with its `.code`) on `.cause` (same pattern as
    // apps/nrms/src/releases.ts's ReleaseExistsError).
    // Only the case-insensitive email index means "already subscribed"; any other unique
    // violation is a bug and must surface as one, not as a misleading 409.
    const cause = (e as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === "23505" && cause.constraint === "subscribers_email_lower_idx") throw new SubscriberExistsError(input.email);
    throw e;
  }
}

/**
 * Counts distinct active subscribers whose own list key matches `listKeys` under the same
 * "matches" rule items are sent by (`matching.ts`'s `matchesItem`, used identically by
 * As-It-Happens and the digest): subscribed to one of `listKeys` directly, or subscribed to
 * "all news" (`*`) when `listKeys` carries a `ministries:` key (legacy
 * DistributionProvider.cs:296) — case-insensitively, lowercased here same as
 * {@link addSubscriber} stores them. Backs both NoD's own `/api/subscribers/count` route and
 * NRMS's "notify ~N subscribers" preview (Task 6's `WorkflowDeps.countSubscribers`, wired
 * through NRMS's own `nodClient`).
 */
export async function countSubscribers(db: Db, listKeys: string[]): Promise<number> {
  const keys = listKeys.map((k) => k.toLowerCase());
  // sql.param, not a bare `${keys}` interpolation: drizzle's sql`` template spreads a plain
  // array into a parenthesized, comma-joined param list (built for `IN (${array})`), which
  // `= ANY(...)` (inside matchesItem) can't take — it needs exactly one bind parameter whose
  // value IS the array, which node-postgres then serializes as a Postgres array literal.
  const r = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT s.id)::int AS n
    FROM ${subscribers} s JOIN ${subscriptions} sub ON sub.subscriber_id = s.id
    WHERE s.status = 'active' AND ${matchesItem(sql`sub.list_key`, sql`${sql.param(keys)}::text[]`)}`);
  return r.rows[0]!.n;
}
