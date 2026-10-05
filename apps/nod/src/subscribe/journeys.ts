import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { DistributionClient } from "../distribution-client";
import { subscribers, subscriptions, type SubscriberPrefs } from "../db/schema";
import { writeHistory } from "./history";
import { infoFor, normaliseEmail, toPrefs, type SubscriberInfo } from "./info";
import { claimLink, createLink, findLink, linksSentLastHour, MAX_EMAILS_PER_HOUR, type LinkRow } from "./links";
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
// Purposes that authorise `update`/`unsubscribe`: a change-email link was sent to an address
// that hasn't been confirmed yet, so it must never act as a manage session (reviewer finding).
const SESSION_PURPOSES = new Set(["verify", "manage"]);

// 23505 unique_violation: another confirm of the same address won the insert race. 40P01
// deadlock_detected: two concurrent inserts for the same new address can each wait on the
// other's not-yet-visible index tuple and get deadlocked — Postgres's detector aborts one of
// them (here, just the inner savepoint) with this code instead. Both mean the same thing for
// us: stop trying to insert and go read the row the other side committed.
function isRetryableConflict(e: unknown): boolean {
  const code = (e as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ?? (e as { code?: unknown })?.code;
  return code === "23505" || code === "40P01";
}

async function bySubscriberEmail(db: DbOrTx, email: string) {
  const [s] = await db.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`);
  return s ?? null;
}

/** After losing an insert race (see `isRetryableConflict`), the other side's row is usually
 * visible immediately — but on the deadlock path specifically, Postgres aborted *us*, and the
 * side that "won" may still be finishing its own transaction. A few short retries cover that
 * window without the caller needing to care which conflict it was. */
async function bySubscriberEmailRetrying(db: DbOrTx, email: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const s = await bySubscriberEmail(db, email);
    if (s) return s;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/** Re-reads a subscriber by id for a "manage view" fallback: null if gone or deleted. */
async function manageViewById(db: DbOrTx, subscriberId: string | null): Promise<SubscriberInfo | null> {
  if (!subscriberId) return null;
  const [s] = await db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
  if (!s || s.status === "deleted") return null;
  return infoFor(db, s.id);
}

/** Same, by email — used when the link itself doesn't carry a subscriber id yet (a verify
 * link's owner is only known once some confirmation of it has actually applied). */
async function manageViewByEmail(db: DbOrTx, email: string): Promise<SubscriberInfo | null> {
  const s = await bySubscriberEmail(db, email);
  if (!s || s.status === "deleted") return null;
  return infoFor(db, s.id);
}

/** Sends a link email, rate-limited; reports whether it actually issued one (false when the
 * address is over its hourly cap) so callers can avoid logging history for a no-op. */
async function issue(deps: JourneyDeps, kind: SystemEmailKind, input: { email: string; subscriberId: string | null; pending: SubscriberPrefs | null }): Promise<boolean> {
  if ((await linksSentLastHour(deps.db, input.email)) >= MAX_EMAILS_PER_HOUR) return false;
  const { id, token } = await createLink(deps.db, { purpose: kind, ...input });
  await sendSystemEmail(deps.distribution, input.email, kind, linkUrl(deps.pageUrl, token), `nod-link-${id}`);
  return true;
}

async function replaceSubscriptions(tx: DbOrTx, subscriberId: string, listKeys: string[]) {
  await tx.delete(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
  if (listKeys.length) await tx.insert(subscriptions).values(listKeys.map((listKey) => ({ subscriberId, listKey })));
}

/** Claims `link` for use AND invalidates every other not-yet-used verify link for the same
 * address, as one statement. Doing both in one statement — rather than claiming this link,
 * then separately updating "the others" — matters for concurrency: two confirms for the same
 * address (the same link twice, or two different pending verify links) would otherwise each
 * lock their own row first and then reach for the other's, a textbook deadlock. A single
 * statement touching the whole address's row set lets Postgres serialize the two attempts
 * instead — whichever transaction gets there first claims everything; the other finds nothing
 * left to claim. Returns whether *this* link was the one that got claimed. Also the guard
 * against an older pending link later re-applying stale preferences (reviewer finding). */
async function claimVerifyLink(tx: DbOrTx, link: LinkRow): Promise<boolean> {
  const r = await tx.execute<{ id: string }>(sql`
    UPDATE subscriber_links SET used_at = now()
     WHERE purpose = 'verify' AND email = ${link.email} AND used_at IS NULL
    RETURNING id`);
  return r.rows.some((row) => row.id === link.id);
}

export async function subscribe(deps: JourneyDeps, info: SubscriberInfo): Promise<void> {
  const { email, prefs } = await toPrefs(deps.db, info);
  const existing = await bySubscriberEmail(deps.db, email);
  if (existing?.status === "active") {
    await issue(deps, "manage", { email, subscriberId: existing.id, pending: null });
    return;
  }
  await issue(deps, "verify", { email, subscriberId: existing?.id ?? null, pending: prefs });
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
  return manageViewById(deps.db, link.subscriberId);
}

type VerifyOutcome = { subscriberId: string } | "unclaimed";

async function applyVerify(deps: JourneyDeps, link: LinkRow): Promise<SubscriberInfo | null> {
  const pending = link.pending!;
  const outcome = await deps.db.transaction<VerifyOutcome>(async (tx) => {
    if (!(await claimVerifyLink(tx, link))) return "unclaimed";

    const existing = await bySubscriberEmail(tx, link.email);
    const fields = {
      status: "active" as const,
      verifiedAt: sql`now()`,
      asItHappens: pending.asItHappens,
      digest: pending.digest,
      endedAt: null,
      source: "self" as const,
    };
    let subscriberId: string;
    if (existing) {
      await tx.update(subscribers).set(fields).where(eq(subscribers.id, existing.id));
      subscriberId = existing.id;
    } else {
      try {
        subscriberId = await tx.transaction(async (tx2) => {
          const [row] = await tx2
            .insert(subscribers)
            .values({ email: link.email, manageToken: randomBytes(32).toString("base64url"), ...fields })
            .returning({ id: subscribers.id });
          return row!.id;
        });
      } catch (e) {
        // Defense in depth: claimVerifyLink above already ensures at most one confirm of this
        // address proceeds past the claim at a time, so this should be unreachable from that
        // path. It still guards the (unrelated) remote case of some other writer inserting the
        // same address between our SELECT and INSERT. Fall back to the now-committed row
        // rather than 500ing.
        if (!isRetryableConflict(e)) throw e;
        const raced = await bySubscriberEmailRetrying(tx, link.email);
        if (!raced) throw e;
        await tx.update(subscribers).set(fields).where(eq(subscribers.id, raced.id));
        subscriberId = raced.id;
      }
    }
    await replaceSubscriptions(tx, subscriberId, pending.listKeys);
    await tx.execute(sql`UPDATE subscriber_links SET subscriber_id = ${subscriberId}, pending = NULL WHERE id = ${link.id}`);
    await writeHistory(tx, subscriberId, SELF, "confirmed", pending.listKeys.join(", "));
    return { subscriberId };
  });
  if (outcome === "unclaimed") return manageViewByEmail(deps.db, link.email);
  return infoFor(deps.db, outcome.subscriberId);
}

type EmailChangeOutcome = "unclaimed" | "not-active" | "moved" | "moved-unsubscribed";

async function applyEmailChange(deps: JourneyDeps, link: LinkRow): Promise<SubscriberInfo | null> {
  if (!link.subscriberId) return null;
  const subscriberId = link.subscriberId;
  const outcome = await deps.db.transaction<EmailChangeOutcome>(async (tx) => {
    if (!(await claimLink(tx, link.id))) return "unclaimed";

    const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    if (!s || s.status !== "active") return "not-active";

    const taken = await bySubscriberEmail(tx, link.email);
    if (taken && taken.id !== subscriberId) {
      if (taken.status === "active") {
        await endSubscriber(tx, subscriberId);
        return "moved-unsubscribed";
      }
      // The address is held by a non-active row (pending/disabled/deleted): it's dead weight,
      // not a live subscriber to protect. Clear it out (links/history cascade) and move in.
      await tx.delete(subscribers).where(eq(subscribers.id, taken.id));
    }
    await tx
      .update(subscribers)
      .set({ email: link.email, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` })
      .where(and(eq(subscribers.id, subscriberId), eq(subscribers.status, "active")));
    await writeHistory(tx, subscriberId, SELF, "email-changed");
    return "moved";
  });

  if (outcome === "unclaimed") return manageViewById(deps.db, subscriberId);
  if (outcome === "not-active" || outcome === "moved-unsubscribed") return null;
  return infoFor(deps.db, subscriberId);
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
  if (!link || link.expired || !link.subscriberId || !SESSION_PURPOSES.has(link.purpose)) return "invalid";
  const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, link.subscriberId));
  if (!s || s.status !== "active") return "invalid";
  const { email, prefs } = await toPrefs(deps.db, info);
  await deps.db.transaction(async (tx) => {
    await tx.update(subscribers).set({ asItHappens: prefs.asItHappens, digest: prefs.digest }).where(eq(subscribers.id, s.id));
    await replaceSubscriptions(tx, s.id, prefs.listKeys);
    await writeHistory(tx, s.id, SELF, "preferences-updated", prefs.listKeys.join(", "));
  });
  if (email !== normaliseEmail(s.email)) {
    const issued = await issue(deps, "change-email", { email, subscriberId: s.id, pending: null });
    if (issued) await writeHistory(deps.db, s.id, SELF, "email-change-requested");
  }
  return "ok";
}

export async function requestManageLink(deps: JourneyDeps, rawEmail: string): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const s = await bySubscriberEmail(deps.db, email);
  if (s?.status !== "active") return;
  // Fire-and-forget: awaiting the link creation + send here would make the response take
  // measurably longer for a subscribed address than for an unknown one, leaking subscription
  // status through timing even though the reply itself never differs (reviewer finding).
  void issue(deps, "manage", { email, subscriberId: s.id, pending: null }).catch((e) =>
    console.error(`[nod] manage link request failed: ${e instanceof Error ? e.message : String(e)}`),
  );
}

export async function checkToken(deps: JourneyDeps, token: string): Promise<boolean> {
  const link = await findLink(deps.db, token);
  return !!link && !link.expired;
}

export async function unsubscribe(deps: JourneyDeps, token: string): Promise<true> {
  let subscriberId: string | null = null;
  const link = await findLink(deps.db, token);
  if (link && !link.expired && link.subscriberId && SESSION_PURPOSES.has(link.purpose)) subscriberId = link.subscriberId;
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
