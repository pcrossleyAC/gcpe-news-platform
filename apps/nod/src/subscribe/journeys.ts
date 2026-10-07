import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { DistributionClient } from "../distribution-client";
import { subscribers, subscriptions, type SubscriberPrefs } from "../db/schema";
import { MEDIA_CATEGORY } from "../lists";
import { lockAddress } from "../locks";
import { optOutMediaMemberships } from "../media-members";
import type { RenderOptions } from "../render";
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
  /** Site URL and optional banner for every verify/manage/change-email email (Task 5). */
  render: RenderOptions;
}

const SELF = "subscriber";
// Purposes that unconditionally authorise `update`/`unsubscribe` once they carry a subscriber id
// (a change-email link needs its own conditional rule below — a link sent to an address that
// hasn't been confirmed yet must never act as a manage session (reviewer finding)).
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

/** Re-exported for every existing caller in this app (`issue()`'s DB calls bind the target
 * email address, so never logging `e.message`/`e.cause.message` matters here as much as
 * anywhere) — the actual implementation is `@gcpe/http-kit`'s shared `safeErrorLabel`, used the
 * same way by Distribution and by `packages/events`' receiver. */
export { safeErrorLabel } from "@gcpe/http-kit";

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
 * address is over its hourly cap) so callers can avoid logging history for a no-op.
 *
 * The count-then-insert is done inside one transaction holding the same per-address advisory
 * lock `lockAddress` uses for confirms: without it, N concurrent calls for the same address can
 * each read the same (stale) count before any of them inserts, and all N pass the cap check
 * (reviewer finding, I2 — 20 parallel subscribes sent 18 emails). The lock serialises the
 * check-and-insert so at most MAX_EMAILS_PER_HOUR ever get created. The email itself is sent
 * after commit — same for both callers (kind="verify" or "manage"), so neither subscribe()
 * branch does more or less work than the other (anti-enumeration). */
async function issue(deps: JourneyDeps, kind: SystemEmailKind, input: { email: string; subscriberId: string | null; pending: SubscriberPrefs | null }): Promise<boolean> {
  const issued = await deps.db.transaction(async (tx) => {
    await lockAddress(tx, input.email);
    if ((await linksSentLastHour(tx, input.email)) >= MAX_EMAILS_PER_HOUR) return null;
    return createLink(tx, { purpose: kind, ...input });
  });
  if (!issued) return false;
  await sendSystemEmail(deps.distribution, input.email, kind, linkUrl(deps.pageUrl, issued.token), `nod-link-${issued.id}`, deps.render);
  return true;
}

/** Replaces a subscriber's non-media subscriptions with `listKeys` (always the public ones `toPrefs`
 * produced). Media memberships are never in `listKeys` (the public manage page doesn't know the
 * category) and must survive untouched (global constraints, "the public manage page never shows
 * or changes media memberships"). */
async function replaceSubscriptions(tx: DbOrTx, subscriberId: string, listKeys: string[]) {
  await tx
    .delete(subscriptions)
    .where(and(eq(subscriptions.subscriberId, subscriberId), sql`${subscriptions.listKey} NOT LIKE ${`${MEDIA_CATEGORY}:%`}`));
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
    await lockAddress(tx, link.email);
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
            .values({ email: link.email, ...fields })
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
    await lockAddress(tx, link.email);
    if (!(await claimLink(tx, link.id))) return "unclaimed";

    const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    if (!s || s.status !== "active") return "not-active";

    const taken = await bySubscriberEmail(tx, link.email);
    if (taken && taken.id !== subscriberId) {
      if (taken.status === "pending" || taken.status === "deleted") {
        // Dead weight, not a live subscriber to protect: clear it out (links/history cascade)
        // and move in.
        await tx.delete(subscribers).where(eq(subscribers.id, taken.id));
      } else {
        // active, or disabled (bounce- or staff-disabled) — a row worth protecting either way:
        // a disabled subscriber is kept, not purged, and can reactivate themselves by
        // subscribing again (bounces.ts). The mover is unsubscribed instead of displacing it;
        // the row at the target address is left untouched.
        await endSubscriber(tx, subscriberId);
        return "moved-unsubscribed";
      }
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

/** Ends a subscriber (4a) and, in the same transaction, opts them out of every media list
 * (global constraints, "Unsubscribe means everything") -- shared by one-click, token-link and
 * every email kind, since they all route through this one function. */
async function endSubscriber(tx: DbOrTx, subscriberId: string) {
  const ended = await tx
    .update(subscribers)
    .set({ status: "deleted", endedAt: sql`now()` })
    .where(and(eq(subscribers.id, subscriberId), sql`${subscribers.status} <> 'deleted'`))
    .returning({ id: subscribers.id });
  if (ended.length) {
    await writeHistory(tx, subscriberId, SELF, "unsubscribed");
    await optOutMediaMemberships(tx, subscriberId, SELF);
  }
}

/** Whether `link` currently authorises a manage session — `update`, `unsubscribe` and (for a
 * change-email link only) `checkToken` all gate on this. A verify or manage link does as soon as
 * it carries a subscriber id. A change-email link is different (controller ruling, C1): before
 * confirmation it authorises nothing — the email hasn't moved yet, so there's nothing to manage —
 * and it only starts authorising once `used_at` is set (confirmed) AND the subscriber it names
 * has actually ended up at `link.email` (the move could instead have unsubscribed the mover, or
 * found the subscriber no longer active, in which case there is still no session). */
async function isSession(db: DbOrTx, link: LinkRow): Promise<boolean> {
  if (!link.subscriberId) return false;
  if (SESSION_PURPOSES.has(link.purpose)) return true;
  if (link.purpose !== "change-email" || link.usedAt === null) return false;
  const [s] = await db.select().from(subscribers).where(eq(subscribers.id, link.subscriberId));
  return !!s && s.email.toLowerCase() === link.email;
}

export async function update(deps: JourneyDeps, token: string, info: SubscriberInfo): Promise<"ok" | "invalid"> {
  const link = await findLink(deps.db, token);
  if (!link || link.expired || !(await isSession(deps.db, link))) return "invalid";
  const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, link.subscriberId!)); // isSession(true) implies non-null
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
    console.error("[nod] manage link request failed", safeErrorLabel(e)),
  );
}

export async function checkToken(deps: JourneyDeps, token: string): Promise<boolean> {
  const link = await findLink(deps.db, token);
  if (!link || link.expired) return false;
  // verify/manage: the activation link itself is still live, regardless of whether it's been
  // confirmed yet. change-email: only once it has become a session (C1) — before that, the
  // move hasn't happened, so there's nothing valid to report.
  if (link.purpose === "change-email") return isSession(deps.db, link);
  return true;
}

export async function unsubscribe(deps: JourneyDeps, token: string): Promise<true> {
  let subscriberId: string | null = null;
  const link = await findLink(deps.db, token);
  if (link && !link.expired && (await isSession(deps.db, link))) subscriberId = link.subscriberId;
  if (!subscriberId) {
    const parsed = parseUnsubscribeToken(deps.linkSecret, token);
    if (parsed) {
      const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, parsed.subscriberId));
      if (s && s.unsubscribeVersion === parsed.version) subscriberId = s.id;
    }
  }
  if (subscriberId) await deps.db.transaction((tx) => endSubscriber(tx, subscriberId!));
  return true;
}
