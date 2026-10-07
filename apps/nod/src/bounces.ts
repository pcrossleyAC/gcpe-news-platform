import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { sqlInterval, type Tx } from "@gcpe/db-kit";
import type { DeliveryBounced, EventEnvelope, EventHandler } from "@gcpe/events";
import { deliveries, subscribers, type DeliveryRow } from "./db/schema";
import { lockAddress } from "./locks";
import { hasMediaMemberships } from "./media-members";
import { writeHistory } from "./subscribe/history";
import { normaliseEmail } from "./subscribe/info";

/** The threshold rule (spec §7, legacy `DistributionProvider.cs:465-506`): once a subscriber's
 * 10 most recent attempted deliveries within this many days are all hard-bounced, they're acted
 * on (disabled, or flagged if they're a media-list member). */
const HARD_BOUNCE_THRESHOLD = 10;
const THRESHOLD_WINDOW_DAYS = 15;
const THRESHOLD_WINDOW_MS = THRESHOLD_WINDOW_DAYS * 24 * 3_600_000;

/** Matching fallback (Global Constraints "NoD threshold"), mirroring Distribution's own
 * recipient-fallback window (bounces/store.ts's RECIPIENT_FALLBACK_WINDOW_MS): when no delivery
 * carries the event's own batchId, the subscriber's most recent attempted delivery, as long as
 * it's recent enough to plausibly be the one that bounced. */
const FALLBACK_MATCH_WINDOW_DAYS = 4;
const FALLBACK_MATCH_WINDOW_MS = FALLBACK_MATCH_WINDOW_DAYS * 24 * 3_600_000;

const BOUNCE_ACTOR = "distribution-bounce";

export interface BounceOptions {
  /** NoD's own appId, exactly as Distribution would record it for a message NoD sent (see
   * distribution-token.ts and env.ts's DISTRIBUTION_APP_ID) -- a `delivery.bounced` event for
   * any other app is ignored. */
  appId: string;
}

export type BounceAction = "none" | "recorded" | "disabled" | "flagged";

async function findSubscriberForUpdate(tx: Tx, email: string) {
  const [row] = await tx.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`).for("update");
  return row ?? null;
}

/** Step 3 of the rule: `distribution_batch_id = batchId` for this subscriber first; falling
 * back to their most recent attempted delivery within {@link FALLBACK_MATCH_WINDOW_DAYS} days
 * when nothing matches the batch id (no delivery was ever stamped with it, or none of this
 * subscriber's deliveries happen to carry it). A digest send can leave more than one delivery
 * row carrying the same batch id (one per item in that digest, all part of the same Distribution
 * message) -- any one of them is as good as another for recording the bounce against. */
async function findDelivery(tx: Tx, subscriberId: string, batchId: string): Promise<DeliveryRow | null> {
  const [byBatch] = await tx
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.subscriberId, subscriberId), eq(deliveries.distributionBatchId, batchId)))
    .orderBy(deliveries.itemKey)
    .limit(1);
  if (byBatch) return byBatch;

  const [fallback] = await tx
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.subscriberId, subscriberId),
        isNotNull(deliveries.attemptedAt),
        sql`${deliveries.attemptedAt} >= now() - ${sqlInterval(FALLBACK_MATCH_WINDOW_MS)}`,
      ),
    )
    .orderBy(desc(deliveries.attemptedAt))
    .limit(1);
  return fallback ?? null;
}

/** Whether this subscriber's {@link HARD_BOUNCE_THRESHOLD} most recent attempted deliveries,
 * within {@link THRESHOLD_WINDOW_DAYS} days, are all hard-bounced -- fewer than the threshold
 * qualifying (whether because they simply don't have that many, or because older ones fall
 * outside the window) never trips it. */
async function thresholdTripped(tx: Tx, subscriberId: string): Promise<boolean> {
  const recent = await tx
    .select({ hardBouncedAt: deliveries.hardBouncedAt })
    .from(deliveries)
    .where(and(eq(deliveries.subscriberId, subscriberId), isNotNull(deliveries.attemptedAt), sql`${deliveries.attemptedAt} >= now() - ${sqlInterval(THRESHOLD_WINDOW_MS)}`))
    .orderBy(desc(deliveries.attemptedAt))
    .limit(HARD_BOUNCE_THRESHOLD);
  return recent.length === HARD_BOUNCE_THRESHOLD && recent.every((d) => d.hardBouncedAt !== null);
}

/**
 * Records one `delivery.bounced` event and, on a hard bounce, applies the 10-in-15-days rule
 * (spec §7). Idempotent two ways over: the event receiver's own inbox dedupe (packages/events)
 * catches an exact outbox retry, and this function is idempotent in its own right against a
 * second, genuinely new hard-bounce event for a delivery already marked -- the guarded UPDATE
 * below only ever marks `hard_bounced_at` once per delivery, so a replay (or a second bounce
 * report Distribution matched to the same delivery) writes no second history row and
 * re-evaluates nothing.
 *
 * Takes the per-address advisory lock and the subscriber row `FOR UPDATE` before anything else
 * (same as 4c's media-member code, media-members.ts), serialising this against every other
 * writer of that address.
 */
export async function onDeliveryBounced(tx: Tx, event: EventEnvelope, opts: BounceOptions): Promise<{ matched: boolean; action: BounceAction }> {
  const data = event.data as DeliveryBounced;
  if (data.appId !== opts.appId) return { matched: false, action: "none" };

  const email = normaliseEmail(data.email);
  await lockAddress(tx, email);
  const subscriber = await findSubscriberForUpdate(tx, email);
  if (!subscriber) return { matched: false, action: "none" };

  const delivery = await findDelivery(tx, subscriber.id, data.batchId);
  if (!delivery) return { matched: false, action: "none" };

  const deliveryKey = and(eq(deliveries.itemKey, delivery.itemKey), eq(deliveries.subscriberId, delivery.subscriberId), eq(deliveries.mode, delivery.mode));

  if (!data.hard) {
    // Soft bounces are recorded and never count toward the threshold (Global Constraints).
    await tx.update(deliveries).set({ bounceStatus: data.status }).where(and(deliveryKey, isNull(deliveries.bounceStatus)));
    return { matched: true, action: "none" };
  }

  // First-wins, race-free: only a delivery with no hard_bounced_at yet is actually updated, so
  // a duplicate hard-bounce event for a delivery already marked updates nothing here -- caught
  // by this one guarded statement rather than a separate read-then-write.
  const updated = await tx
    .update(deliveries)
    .set({ hardBouncedAt: sql`now()`, bounceStatus: data.status })
    .where(and(deliveryKey, isNull(deliveries.hardBouncedAt)))
    .returning({ itemKey: deliveries.itemKey });
  if (updated.length === 0) return { matched: true, action: "none" };

  if (!(await thresholdTripped(tx, subscriber.id))) {
    await writeHistory(tx, subscriber.id, BOUNCE_ACTOR, "bounce-recorded", data.status);
    return { matched: true, action: "recorded" };
  }

  if (await hasMediaMemberships(tx, subscriber.id)) {
    await tx.update(subscribers).set({ needsAttention: "bouncing", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriber.id));
    await writeHistory(tx, subscriber.id, BOUNCE_ACTOR, "bounce-flagged");
    return { matched: true, action: "flagged" };
  }

  if (subscriber.status === "active") {
    await tx.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, subscriber.id));
    await writeHistory(tx, subscriber.id, BOUNCE_ACTOR, "bounce-disabled", `${HARD_BOUNCE_THRESHOLD}/${THRESHOLD_WINDOW_DAYS}d`);
    return { matched: true, action: "disabled" };
  }

  // Already not active and not a media member (e.g. already disabled some other way) -- the
  // threshold has nothing left to do; still recorded.
  await writeHistory(tx, subscriber.id, BOUNCE_ACTOR, "bounce-recorded", data.status);
  return { matched: true, action: "recorded" };
}

/** `delivery.bounced`, from Distribution alone, routed to NoD only for the app that sent the
 * message (app.ts wires this into the event receiver's handler chain). */
export function bounceHandler(opts: BounceOptions): (event: EventEnvelope) => EventHandler | undefined {
  const handle: EventHandler = async (tx, event) => {
    await onDeliveryBounced(tx, event, opts);
  };
  return (event: EventEnvelope): EventHandler | undefined => {
    if (event.source !== "distribution" || event.type !== "delivery.bounced") return undefined;
    return handle;
  };
}
