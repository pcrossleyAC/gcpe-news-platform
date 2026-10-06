import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { subscriberLinks } from "./db/schema";
import { linkUrl } from "./subscribe/emails";
import { LINK_TTL_MS } from "./subscribe/links";
import { hashToken, newLinkToken, unsubscribeToken } from "./subscribe/tokens";

/** Inserted in chunks this size (recipient-links.ts's own bulk insert, not one row per
 * `createLink` call) — a single release's recipient list can run into the thousands. */
const INSERT_CHUNK_SIZE = 1_000;

export interface RecipientLinkOptions {
  /** The manage page a `{{manageUrl}}` link opens (same as subscribe/journeys.ts's JourneyDeps.pageUrl). */
  pageUrl: string;
  /** Base URL of the public Subscribe API, for the one-click unsubscribe path. */
  subscribeApiUrl: string;
  /** HMAC key for unsubscribe tokens (subscribe/tokens.ts). */
  linkSecret: string;
}

/**
 * Builds the per-recipient `{{manageUrl}}`/`{{unsubscribeUrl}}` substitutions an outbound email
 * carries (global constraints: "Per-email links"). For each member, issues one fresh 24-hour
 * `manage` link with `origin: 'send'` (doesn't count toward the 3-per-hour request cap —
 * links.ts's `linksSentLastHour`) and derives the stable, HMAC one-click unsubscribe URL
 * (subscribe/tokens.ts's `unsubscribeToken` — never stored, so no insert needed for it).
 *
 * Inserts the manage-link rows in chunks of 1,000 rather than one `createLink` call per member:
 * a release's recipient list can be large, and this is one bulk insert per chunk instead of N
 * round trips.
 */
export async function recipientSubstitutions(
  db: DbOrTx,
  members: { subscriberId: string; email: string; unsubscribeVersion: number }[],
  opts: RecipientLinkOptions,
): Promise<Map<string, { manageUrl: string; unsubscribeUrl: string }>> {
  const result = new Map<string, { manageUrl: string; unsubscribeUrl: string }>();
  if (members.length === 0) return result;

  const apiBase = opts.subscribeApiUrl.replace(/\/$/, "");
  const rows = members.map((m) => {
    const token = newLinkToken();
    result.set(m.subscriberId, {
      manageUrl: linkUrl(opts.pageUrl, token),
      unsubscribeUrl: `${apiBase}/OneClickUnsubscribe/${encodeURIComponent(unsubscribeToken(opts.linkSecret, m.subscriberId, m.unsubscribeVersion))}`,
    });
    return {
      tokenHash: hashToken(token),
      purpose: "manage" as const,
      origin: "send" as const,
      email: m.email.trim().toLowerCase(),
      subscriberId: m.subscriberId,
      // Clocks constraint: the database clock, not Date.now() — same expression createLink uses.
      expiresAt: sql`now() + make_interval(secs => ${LINK_TTL_MS / 1000})`,
    };
  });

  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    await db.insert(subscriberLinks).values(rows.slice(i, i + INSERT_CHUNK_SIZE));
  }

  return result;
}
