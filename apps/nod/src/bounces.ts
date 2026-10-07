import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { sqlInterval, type DbOrTx, type Tx } from "@gcpe/db-kit";
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
/** Exported: the daily bounce summary (bounce-summary.ts) reports the same "n/15d" count for
 * a subscriber who hasn't yet tripped the threshold. */
export const THRESHOLD_WINDOW_DAYS = 15;
const THRESHOLD_WINDOW_MS = THRESHOLD_WINDOW_DAYS * 24 * 3_600_000;

/** Exported so the daily bounce summary (bounce-summary.ts) can find the same history rows
 * this module writes, by the same actor, without duplicating the literal string. */
export const BOUNCE_ACTOR = "distribution-bounce";

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

interface DeliveryMatch {
  rows: DeliveryRow[];
  /** Reaches exactly {@link rows} -- built alongside the query that found them, never
   * re-inferred from the rows themselves, so the UPDATEs below touch precisely what was
   * matched. */
  where: ReturnType<typeof and>;
}

/**
 * Step 3 of the rule, and what it marks: the threshold's unit is an *email*, not a delivery
 * row -- a digest send leaves one delivery row per item, all stamped with the same
 * `distribution_batch_id` by send-jobs.ts's sendAllChunks (one Distribution message, one
 * bounce, if it bounces at all). So a match returns every row that email touched, and the
 * caller marks all of them together, not just one.
 *
 * Controller ruling: NoD has no recipient fallback of its own. Distribution's event always
 * carries a real batchId -- it has already done its own recipient-within-4-days fallback on
 * its side (bounces/store.ts) before ever emitting this event, so the batchId it hands over
 * always names the message that actually bounced. If no delivery row of this subscriber's own
 * carries it (a verification/manage-link email, which gets no deliveries row at all, or a
 * handoff whose own batch-id stamp never landed), there is nothing here to mark -- guessing at
 * a different, unrelated send by recency would risk misattributing the bounce.
 */
async function findDeliveryMatch(tx: Tx, subscriberId: string, batchId: string): Promise<DeliveryMatch | null> {
  const where = and(eq(deliveries.subscriberId, subscriberId), eq(deliveries.distributionBatchId, batchId));
  const rows = await tx.select().from(deliveries).where(where);
  if (rows.length === 0) return null;
  return { rows, where };
}

/**
 * The grouping that turns delivery rows into *emails* -- by whatever identifies one send
 * (`distribution_batch_id`, falling back to `job_id`, falling back to the row itself for a
 * delivery with neither) attempted within {@link THRESHOLD_WINDOW_DAYS} days -- with one
 * `bounced` flag per email (true iff any row in that email was hard-bounced). Shared by
 * {@link thresholdTripped} and {@link countBouncedEmails} so the two can never grade a
 * subscriber's emails differently; callers append their own `ORDER BY`/`LIMIT` as needed.
 * Only emails attempted after the subscriber's `bounce_window_from` count -- a reactivation
 * restarts the count.
 */
function groupedBouncedEmailsSql(subscriberId: string): SQL {
  return sql`
    SELECT bool_or(hard_bounced_at IS NOT NULL) AS bounced
      FROM deliveries
     WHERE subscriber_id = ${subscriberId}
       AND attempted_at IS NOT NULL
       AND attempted_at >= now() - ${sqlInterval(THRESHOLD_WINDOW_MS)}
       AND attempted_at > COALESCE((SELECT bounce_window_from FROM subscribers WHERE id = ${subscriberId}), '-infinity'::timestamptz)
     GROUP BY COALESCE(distribution_batch_id::text, job_id::text, item_key || mode)
  `;
}

/**
 * Whether this subscriber's {@link HARD_BOUNCE_THRESHOLD} most recent *emails* (see
 * {@link groupedBouncedEmailsSql}) are all hard-bounced. A digest's several item rows count as
 * the one email they actually were; fewer than the threshold qualifying (whether because there
 * simply aren't that many, or because older ones fall outside the window) never trips it.
 */
async function thresholdTripped(tx: Tx, subscriberId: string): Promise<boolean> {
  // The tiebreaker (the same grouping expression {@link groupedBouncedEmailsSql} groups by)
  // makes which emails land inside the LIMIT deterministic when two or more share the exact
  // same max(attempted_at) -- without it, Postgres is free to return ties in any order, which
  // could change the threshold's answer run to run for the same data.
  const { rows } = await tx.execute<{ bounced: boolean }>(sql`
    ${groupedBouncedEmailsSql(subscriberId)}
    ORDER BY max(attempted_at) DESC, COALESCE(distribution_batch_id::text, job_id::text, item_key || mode) DESC
    LIMIT ${HARD_BOUNCE_THRESHOLD}
  `);
  return rows.length === HARD_BOUNCE_THRESHOLD && rows.every((r) => r.bounced === true);
}

/**
 * How many of this subscriber's emails (see {@link groupedBouncedEmailsSql}, the same grouping
 * {@link thresholdTripped} uses) are hard-bounced within the window, with no `LIMIT 10`: the
 * daily bounce summary's own "recorded (n/15d)" count (bounce-summary.ts), which needs the
 * real count, not just whether it's already tripped the threshold.
 */
export async function countBouncedEmails(db: DbOrTx, subscriberId: string): Promise<number> {
  const { rows } = await db.execute<{ bounced: boolean }>(groupedBouncedEmailsSql(subscriberId));
  return rows.filter((r) => r.bounced === true).length;
}

/**
 * Records one `delivery.bounced` event and, on a hard bounce, applies the 10-in-15-days rule
 * (spec §7). Idempotent two ways over: the event receiver's own inbox dedupe (packages/events)
 * catches an exact outbox retry, and this function is idempotent in its own right against a
 * second, genuinely new hard-bounce event for the same email -- the guarded UPDATE below only
 * ever marks a delivery's `hard_bounced_at` once, so if every one of this email's rows is
 * already marked, nothing is newly updated, and a replay (or a second bounce report
 * Distribution matched to the same email) writes no second history row and re-evaluates
 * nothing.
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

  const match = await findDeliveryMatch(tx, subscriber.id, data.batchId);
  if (!match) return { matched: false, action: "none" };

  if (!data.hard) {
    // Soft bounces are recorded and never count toward the threshold (Global Constraints).
    await tx.update(deliveries).set({ bounceStatus: data.status }).where(and(match.where, isNull(deliveries.bounceStatus)));
    return { matched: true, action: "none" };
  }

  // First-wins, race-free: only a row with no hard_bounced_at yet is actually updated, across
  // every row this email touched -- a duplicate hard-bounce event for an email already fully
  // marked updates nothing here, caught by this one guarded statement rather than a separate
  // read-then-write.
  const updated = await tx
    .update(deliveries)
    .set({ hardBouncedAt: sql`now()`, bounceStatus: data.status })
    .where(and(match.where, isNull(deliveries.hardBouncedAt)))
    .returning({ itemKey: deliveries.itemKey });
  if (updated.length === 0) return { matched: true, action: "none" };

  if (!(await thresholdTripped(tx, subscriber.id))) {
    await writeHistory(tx, subscriber.id, BOUNCE_ACTOR, "bounce-recorded", data.status);
    return { matched: true, action: "recorded" };
  }

  if (await hasMediaMemberships(tx, subscriber.id)) {
    // Flagged once: never overwrites an existing reason (e.g. a Media Hub sync's own
    // "email-gone"/"email-taken") and, once already "bouncing", a later hard bounce that
    // re-trips the threshold (chronically so, for a media member who keeps being sent to)
    // writes no second bounce-flagged row and doesn't reset attention_at.
    const flagged = await tx
      .update(subscribers)
      .set({ needsAttention: "bouncing", attentionAt: sql`now()` })
      .where(and(eq(subscribers.id, subscriber.id), isNull(subscribers.needsAttention)))
      .returning({ id: subscribers.id });
    if (flagged.length > 0) {
      await writeHistory(tx, subscriber.id, BOUNCE_ACTOR, "bounce-flagged");
      return { matched: true, action: "flagged" };
    }
    if (subscriber.needsAttention === "bouncing") {
      // Already flagged "bouncing" by an earlier trip of this same threshold -- nothing new
      // happened, so nothing new is written (no second bounce-flagged row, no attention_at
      // reset).
      return { matched: true, action: "flagged" };
    }
    // Flagged for something else entirely (e.g. a Media Hub sync collision) -- that reason is
    // never overwritten, but staff should still see that this bounce happened.
    await writeHistory(tx, subscriber.id, BOUNCE_ACTOR, "bounce-recorded", data.status);
    return { matched: true, action: "recorded" };
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
