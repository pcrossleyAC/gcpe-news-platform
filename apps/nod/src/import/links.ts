import { inArray } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { subscriberLinks, subscribers } from "../db/schema";
import { legacyTokenHash } from "../subscribe/legacy-token";
import { guidKey } from "./map";
import { Q_LIVE_MANAGE_LINKS } from "./queries";
import type { NodImportReport } from "./report";

const TABLE = "SubscriberLink";
const LINK_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHUNK = 1_000;

type LegacyLinkRow = {
  LinkGuid: string | null;
  SubscriberGuid: string;
  ExpiryDate: Date;
};

/** The normalised LinkGuid, or null unless it is a hyphenated GUID (one pair of braces is tolerated). */
function linkId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let k = guidKey(raw);
  if (k.startsWith("{") && k.endsWith("}")) k = guidKey(k.slice(1, -1));
  return LINK_GUID.test(k) ? k : null;
}

/**
 * Copies the legacy manage links that have not yet expired, for subscribers who are in NoD and
 * not ended, so the links in recently sent emails keep working. Each lands as a `send` link under
 * the hash `legacyTokenHash` computes, which NoD's link lookup also accepts for the legacy token
 * shapes. Reports by SubscriberGuid: a live link id is a credential, so no link id (and no
 * address) reaches the report. A link under a duplicate record that lost its address's pick
 * follows the winner (`ctx.winnerOf`), the one NoD holds.
 */
export async function importManageLinks(db: Db, source: LegacySource, ctx: { report: NodImportReport; timeZone: string; runAt: Date; winnerOf?: Map<string, string> }): Promise<void> {
  const { report } = ctx;
  const rows = await source.query<LegacyLinkRow>(Q_LIVE_MANAGE_LINKS);
  const owner = (raw: unknown) => {
    const g = guidKey(String(raw));
    return ctx.winnerOf?.get(g) ?? g;
  };
  const wanted = [...new Set(rows.map((r) => owner(r.SubscriberGuid)))];
  const known = new Map<string, { email: string; status: string }>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const found = await db.select({ id: subscribers.id, email: subscribers.email, status: subscribers.status }).from(subscribers).where(inArray(subscribers.id, wanted.slice(i, i + CHUNK).filter((g) => LINK_GUID.test(g))));
    for (const s of found) known.set(s.id, s);
  }
  for (const r of rows) {
    report.count(TABLE, "legacy");
    const legacyId = guidKey(String(r.SubscriberGuid));
    const subscriberId = owner(r.SubscriberGuid);
    const id = linkId(r.LinkGuid);
    const subscriber = known.get(subscriberId);
    if (!id) report.skip(TABLE, "malformed link id", legacyId);
    else if (!subscriber) report.skip(TABLE, "subscriber not in NoD", legacyId);
    else if (subscriber.status === "deleted") report.skip(TABLE, "subscriber ended", legacyId);
    else {
      const expiresAt = wallClockToInstant(r.ExpiryDate, ctx.timeZone);
      if (expiresAt <= ctx.runAt) {
        report.skip(TABLE, "expired", legacyId);
        continue;
      }
      const inserted = await db
        .insert(subscriberLinks)
        .values({ tokenHash: legacyTokenHash(id), purpose: "manage", origin: "send", email: subscriber.email, subscriberId, expiresAt })
        .onConflictDoNothing({ target: subscriberLinks.tokenHash })
        .returning({ tokenHash: subscriberLinks.tokenHash });
      if (inserted.length > 0) report.count(TABLE, "imported");
      else report.skip(TABLE, "already present", legacyId);
    }
  }
}
