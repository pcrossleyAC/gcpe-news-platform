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
 */
export async function addSubscriber(db: Db, input: AddSubscriberInput): Promise<{ id: string }> {
  const manageToken = randomBytes(32).toString("base64url");
  const listKeys = input.lists === "all" ? ["*"] : input.lists.map((key) => key.toLowerCase());
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
    if ((e as { cause?: { code?: string } }).cause?.code === "23505") throw new SubscriberExistsError(input.email);
    throw e;
  }
}
