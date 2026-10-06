import { randomBytes } from "node:crypto";
import type { Db } from "@gcpe/db-kit";
import { subscribers, subscriptions } from "./db/schema";

/** Thrown by {@link addSubscriber} on a case-insensitive email clash (subscribers_email_lower_idx). */
export class SubscriberExistsError extends Error {}

export interface AddSubscriberInput {
  email: string;
  /** "all" subscribes to every list ('*'); otherwise one or more index keys (e.g. "ministries:Health"). */
  lists: string[] | "all";
}

/**
 * Phase 2 ruling: subscribers are added already verified through the admin API, standing in
 * for the double opt-in journey that arrives in Phase 4 — so this sets verifiedAt immediately.
 * List keys are lowercased here (the receiver compares against indexKeysFor's lowercased
 * output); validating their shape ('<kind>:<key>') is the HTTP layer's job (routes.ts).
 * Deduped after lowercasing: two input keys that only differ by casing (e.g.
 * "ministries:Health" and "ministries:health") would otherwise collide on the
 * (subscriberId, listKey) primary key mid-insert.
 */
export async function addSubscriber(db: Db, input: AddSubscriberInput): Promise<{ id: string }> {
  const manageToken = randomBytes(32).toString("base64url");
  const listKeys = input.lists === "all" ? ["*"] : [...new Set(input.lists.map((key) => key.toLowerCase()))];
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(subscribers)
        .values({ email: input.email, manageToken, verifiedAt: new Date() })
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
