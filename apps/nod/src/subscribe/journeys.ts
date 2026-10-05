import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { DistributionClient } from "../distribution-client";
import { subscribers, subscriptions, type SubscriberPrefs } from "../db/schema";
import { writeHistory } from "./history";
import { infoFor, normaliseEmail, toPrefs, type SubscriberInfo } from "./info";
import { createLink, findLink, linksSentLastHour, markLinkUsed, MAX_EMAILS_PER_HOUR, type LinkRow } from "./links";
import { linkUrl, sendSystemEmail, type SystemEmailKind } from "./emails";
import { parseUnsubscribeToken } from "./tokens";

export interface JourneyDeps {
  db: Db;
  distribution: Pick<DistributionClient, "send">;
  /** Page the emailed links open (?token= is appended): the manage page. */
  pageUrl: string;
  /** HMAC secret for unsubscribe tokens (≥ 32 chars). */
  linkSecret: string;
}

const SELF = "subscriber";

async function bySubscriberEmail(db: DbOrTx, email: string) {
  const [s] = await db.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`);
  return s ?? null;
}

async function issue(deps: JourneyDeps, kind: SystemEmailKind, input: { email: string; subscriberId: string | null; pending: SubscriberPrefs | null }) {
  if ((await linksSentLastHour(deps.db, input.email)) >= MAX_EMAILS_PER_HOUR) return;
  const { id, token } = await createLink(deps.db, { purpose: kind, ...input });
  await sendSystemEmail(deps.distribution, input.email, kind, linkUrl(deps.pageUrl, token), `nod-link-${id}`);
}

async function replaceSubscriptions(tx: DbOrTx, subscriberId: string, listKeys: string[]) {
  await tx.delete(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
  if (listKeys.length) await tx.insert(subscriptions).values(listKeys.map((listKey) => ({ subscriberId, listKey })));
}

export async function subscribe(deps: JourneyDeps, info: SubscriberInfo): Promise<void> {
  const { email, prefs } = await toPrefs(deps.db, info);
  const existing = await bySubscriberEmail(deps.db, email);
  if (existing?.status === "active") return issue(deps, "manage", { email, subscriberId: existing.id, pending: null });
  return issue(deps, "verify", { email, subscriberId: existing?.id ?? null, pending: prefs });
}

const EMPTY: Omit<SubscriberInfo, "emailAddress"> = {
  subscribedCategories: {}, isAllNews: false, isAsItHappens: false, isDailyDigest: false,
  isAdminRegistration: false, notifyIfNewCategories: false, expiredLinkOrUnverifiedEmail: false,
};

export async function confirm(deps: JourneyDeps, token: string): Promise<SubscriberInfo | null> {
  const link = await findLink(deps.db, token);
  if (!link) return null;
  if (link.expired) return { ...EMPTY, emailAddress: link.email, expiredLinkOrUnverifiedEmail: true };

  if (link.purpose === "verify" && link.usedAt === null && link.pending) return applyVerify(deps, link);
  if (link.purpose === "change-email" && link.usedAt === null) return applyEmailChange(deps, link);
  if (!link.subscriberId) return null;
  const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, link.subscriberId));
  if (!s || s.status === "deleted") return null;
  return infoFor(deps.db, s.id);
}

async function applyVerify(deps: JourneyDeps, link: LinkRow): Promise<SubscriberInfo> {
  const pending = link.pending!;
  const id = await deps.db.transaction(async (tx) => {
    const existing = await bySubscriberEmail(tx, link.email);
    const fields = { status: "active" as const, verifiedAt: sql`now()`, asItHappens: pending.asItHappens, digest: pending.digest, endedAt: null };
    let subscriberId: string;
    if (existing) {
      await tx.update(subscribers).set(fields).where(eq(subscribers.id, existing.id));
      subscriberId = existing.id;
    } else {
      const [row] = await tx
        .insert(subscribers)
        .values({ email: link.email, manageToken: randomBytes(32).toString("base64url"), source: "self", ...fields })
        .returning({ id: subscribers.id });
      subscriberId = row!.id;
    }
    await replaceSubscriptions(tx, subscriberId, pending.listKeys);
    await tx.execute(sql`UPDATE subscriber_links SET subscriber_id = ${subscriberId}, pending = NULL WHERE id = ${link.id}`);
    await markLinkUsed(tx, link.id);
    await writeHistory(tx, subscriberId, SELF, "confirmed", pending.listKeys.join(", "));
    return subscriberId;
  });
  return infoFor(deps.db, id);
}

async function applyEmailChange(deps: JourneyDeps, link: LinkRow): Promise<SubscriberInfo | null> {
  if (!link.subscriberId) return null;
  const moved = await deps.db.transaction(async (tx) => {
    await markLinkUsed(tx, link.id);
    const taken = await bySubscriberEmail(tx, link.email);
    if (taken && taken.id !== link.subscriberId) {
      await endSubscriber(tx, link.subscriberId!);
      return false;
    }
    await tx
      .update(subscribers)
      .set({ email: link.email, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` })
      .where(and(eq(subscribers.id, link.subscriberId!), eq(subscribers.status, "active")));
    await writeHistory(tx, link.subscriberId!, SELF, "email-changed");
    return true;
  });
  return moved ? infoFor(deps.db, link.subscriberId) : null;
}

async function endSubscriber(tx: DbOrTx, subscriberId: string) {
  const ended = await tx
    .update(subscribers)
    .set({ status: "deleted", endedAt: sql`now()` })
    .where(and(eq(subscribers.id, subscriberId), sql`${subscribers.status} <> 'deleted'`))
    .returning({ id: subscribers.id });
  if (ended.length) await writeHistory(tx, subscriberId, SELF, "unsubscribed");
}

export async function update(deps: JourneyDeps, token: string, info: SubscriberInfo): Promise<"ok" | "invalid"> {
  const link = await findLink(deps.db, token);
  if (!link || link.expired || !link.subscriberId) return "invalid";
  const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, link.subscriberId));
  if (!s || s.status !== "active") return "invalid";
  const { email, prefs } = await toPrefs(deps.db, info);
  await deps.db.transaction(async (tx) => {
    await tx.update(subscribers).set({ asItHappens: prefs.asItHappens, digest: prefs.digest }).where(eq(subscribers.id, s.id));
    await replaceSubscriptions(tx, s.id, prefs.listKeys);
    await writeHistory(tx, s.id, SELF, "preferences-updated", prefs.listKeys.join(", "));
  });
  if (email !== normaliseEmail(s.email)) {
    await writeHistory(deps.db, s.id, SELF, "email-change-requested");
    await issue(deps, "change-email", { email, subscriberId: s.id, pending: null });
  }
  return "ok";
}

export async function requestManageLink(deps: JourneyDeps, rawEmail: string): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const s = await bySubscriberEmail(deps.db, email);
  if (s?.status === "active") await issue(deps, "manage", { email, subscriberId: s.id, pending: null });
}

export async function checkToken(deps: JourneyDeps, token: string): Promise<boolean> {
  const link = await findLink(deps.db, token);
  return !!link && !link.expired;
}

export async function unsubscribe(deps: JourneyDeps, token: string): Promise<true> {
  let subscriberId: string | null = null;
  const link = await findLink(deps.db, token);
  if (link && !link.expired && link.subscriberId) subscriberId = link.subscriberId;
  if (!subscriberId) {
    const parsed = parseUnsubscribeToken(deps.linkSecret, token);
    if (parsed) {
      const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, parsed.subscriberId));
      if (s && s.unsubscribeVersion === parsed.version) subscriberId = s.id;
    }
  }
  if (!subscriberId && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    // Phase 2 footers carry subscribers.manage_token; honoured until 4b replaces those links.
    const [s] = await deps.db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.manageToken, token));
    subscriberId = s?.id ?? null;
  }
  if (subscriberId) await deps.db.transaction((tx) => endSubscriber(tx, subscriberId!));
  return true;
}
