import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { asItHappensRecipient, DIGEST_ITEM_RULE, DIGEST_SUBSCRIBER, matchesPublicly, mediaRecipient } from "./recipients";

export interface ReleaseAudienceInput {
  /** The release's own list keys (events' indexKeysFor), as its item will carry them. */
  listKeys: string[];
  /** NoD media list keys (`media-distribution-lists:<key>`); empty when no media email goes out. */
  mediaListKeys: string[];
  /** The release's "Send to News On Demand subscribers". */
  toSubscribers: boolean;
  /** The release's post kind ("releases", "advisories", …). */
  postKind: string;
}

export interface ReleaseAudience {
  /** Emailed As it happens when it goes out (someone also on one of its media lists gets only the media copy). */
  asItHappens: number;
  /** In the next 5 pm daily digest after it goes out, while it's still on the site. */
  digest: number;
  /** Media contacts on its active media lists. */
  mediaContacts: number;
}

/**
 * Suite review R6: who a first publish of this release would reach, worked out with the very
 * rules the senders use (recipients.ts), in NoD's own order: the media send first, then
 * As-It-Happens without anyone the media send already took, then the daily digest. Read-only.
 */
export async function releaseAudience(db: DbOrTx, input: ReleaseAudienceInput): Promise<ReleaseAudience> {
  const keys = sql`${sql.param(input.listKeys.map((k) => k.toLowerCase()))}::text[]`;
  const media = sql`${sql.param(input.mediaListKeys.map((k) => k.toLowerCase()))}::text[]`;
  const { rows } = await db.execute<{ media: number; aih: number; digest: number }>(sql`
    SELECT
      count(*) FILTER (WHERE ${mediaRecipient(media)})::int AS media,
      count(*) FILTER (WHERE ${input.toSubscribers} AND ${asItHappensRecipient(keys)} AND NOT ${mediaRecipient(media)})::int AS aih,
      count(*) FILTER (WHERE ${DIGEST_SUBSCRIBER} AND ${matchesPublicly(keys)}
        AND EXISTS (SELECT 1 FROM (VALUES ('release', ${input.toSubscribers}::boolean, NULL::timestamptz, ${input.postKind}::text)) AS i(kind, to_subscribers, withdrawn_at, post_kind)
                     WHERE ${DIGEST_ITEM_RULE}))::int AS digest
    FROM subscribers s`);
  const r = rows[0]!;
  return { asItHappens: r.aih, digest: r.digest, mediaContacts: r.media };
}
