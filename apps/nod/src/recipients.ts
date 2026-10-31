import { sql, type SQL } from "drizzle-orm";
import { matchesItem } from "./matching";

/**
 * Who each NoD send reaches, as SQL over a `subscribers s` row: one copy of each rule, shared by
 * the senders themselves (media-send.ts, as-it-happens.ts, digest.ts) and by the publish
 * preview's counts (audience.ts), so the numbers an editor sees before publishing are worked out
 * exactly as the sends are (suite review R6).
 */

/** An active subscriber with a subscription matching the item publicly (matching.ts's rule,
 * "all news" included). */
export function matchesPublicly(itemListKeys: SQL): SQL {
  return sql`(s.status = 'active' AND EXISTS (SELECT 1 FROM subscriptions ps WHERE ps.subscriber_id = s.id AND ${matchesItem(sql`ps.list_key`, itemListKeys)}))`;
}

/** Media send: an active subscriber in one of these media lists, where the list itself is still
 * active (a member of a list staff has since retired gets nothing). */
export function mediaRecipient(mediaListKeys: SQL): SQL {
  return sql`(s.status = 'active' AND EXISTS (SELECT 1 FROM subscriptions ms JOIN lists ml ON ml.list_key = ms.list_key
    WHERE ms.subscriber_id = s.id AND ml.active = true AND ms.list_key = ANY(${mediaListKeys})))`;
}

/** As-It-Happens: an active subscriber who chose As it happens and matches the item. The send
 * also leaves out anyone who already has a digest or media copy of the item (as-it-happens.ts). */
export function asItHappensRecipient(itemListKeys: SQL): SQL {
  return sql`(s.as_it_happens = true AND ${matchesPublicly(itemListKeys)})`;
}

/** Daily digest: an active subscriber who chose the digest. Which items it takes is
 * {@link DIGEST_ITEM_RULE}. */
export const DIGEST_SUBSCRIBER = sql`(s.status = 'active' AND s.digest)`;

/** The items a daily digest takes (over an `items`-shaped row's own columns): releases sent to
 * subscribers, not withdrawn, never advisories. */
export const DIGEST_ITEM_RULE = sql`(kind = 'release' AND to_subscribers AND withdrawn_at IS NULL AND COALESCE(post_kind, '') <> 'advisories')`;
