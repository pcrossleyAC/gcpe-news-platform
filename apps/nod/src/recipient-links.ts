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

// newLinkToken()'s randomBytes(32).toString("base64url") is always exactly this many
// characters, regardless of value -- a fixed function of the byte count, not the bytes
// themselves.
const MANAGE_TOKEN_LEN = 43;
// unsubscribeToken()'s `<subscriberId>.<version>.<mac>`: a uuid (36), ".", the version's own
// digits, ".", and an HMAC-SHA256 digest as base64url (also always 43 characters).
const UUID_LEN = 36;
const MAC_LEN = 43;

/**
 * The exact length a real `{{manageUrl}}`/`{{unsubscribeUrl}}` substitution will be for this
 * deployment's `opts` (and, for the unsubscribe token, a subscriber whose `unsubscribe_version`
 * is `unsubscribeVersionDigits` digits wide). Defaults to 10 digits -- a safe overestimate for
 * any version this deployment will plausibly reach, rather than 1 (true only through a
 * subscriber's 9th email change), which under-measures every version from 10 on and makes the
 * byte-size probe this sizes (send-jobs.ts) under-count a part's real request size. Used only to
 * size that probe's placeholders with same-length (but not real) strings, never to build an
 * actual link -- see {@link recipientSubstitutions} for that.
 */
export function placeholderLinkLengths(opts: RecipientLinkOptions, unsubscribeVersionDigits = 10): { manageUrlLen: number; unsubscribeUrlLen: number } {
  const manageUrlLen = linkUrl(opts.pageUrl, "x".repeat(MANAGE_TOKEN_LEN)).length;
  const tokenLen = UUID_LEN + 1 + unsubscribeVersionDigits + 1 + MAC_LEN;
  const apiBase = opts.subscribeApiUrl.replace(/\/$/, "");
  const unsubscribeUrlLen = `${apiBase}/OneClickUnsubscribe/${encodeURIComponent("x".repeat(tokenLen))}`.length;
  return { manageUrlLen, unsubscribeUrlLen };
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
