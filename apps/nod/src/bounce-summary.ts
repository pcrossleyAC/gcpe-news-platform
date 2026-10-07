import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx, TestClock } from "@gcpe/db-kit";
import { sqlNow } from "@gcpe/db-kit";
import { escapeHtml } from "@gcpe/http-kit";
import { BOUNCE_ACTOR, countBouncedEmails, THRESHOLD_WINDOW_DAYS } from "./bounces";
import { todaysCutoff } from "./digest";
import type { DistributionClient } from "./distribution-client";
import { nodSettings } from "./db/schema";
import { hasMediaMemberships } from "./media-members";
import { safeErrorLabel } from "./subscribe/journeys";

/** Daily at 08:00 BC time (Global Constraints "Summary email"), the same `dailyCutoff`/
 * `todaysCutoff` shape as the digest (17:00) and the Media Hub sync (02:00) -- but gated with
 * `todaysCutoff`, never `dailyCutoff`: this must never fire before 08:00 even on the very
 * first run (see {@link claim}), whereas the digest and media sync are meant to catch up
 * immediately on a cutoff they're already late for. */
export const BOUNCE_SUMMARY_HOUR = 8;

const DAY_MS = 24 * 3_600_000;

/** How long a claimed lease is good for without being stamped done. A lease that expires
 * before `finish` runs (a crash, a hung Distribution call) is simply claimed afresh next
 * time -- there is no resumable state to take over, unlike `media_sync_lease`. */
const LEASE_MS = 5 * 60_000;

type BounceSummaryAction = "bounce-recorded" | "bounce-disabled" | "bounce-flagged";

/** One bounced subscriber's latest history action in the window, plus the status/hard flag
 * off whichever delivery row most recently hard-bounced for them (joined separately from the
 * history row itself: a soft bounce never writes history, so a subscriber's *latest* bounce
 * action is always a hard one, and the matching delivery row carries the status code the
 * history row's own `detail` doesn't always repeat -- see {@link outcomeFor}). */
type SummaryRow = {
  subscriber_id: string;
  email: string;
  action: BounceSummaryAction;
  detail: string;
  bounce_status: string | null;
};

/**
 * One row per subscriber bounced in `(windowStart, dbNow]`: their *latest* `bounce-recorded`/
 * `bounce-disabled`/`bounce-flagged` history row (a subscriber acted on more than once in the
 * window gets one line, their most recent outcome -- never three to its own three)
 * left-joined to their most recent hard-bounced delivery row, for the status code.
 *
 * The delivery join is scoped to exactly this window's own subscribers and to
 * `hard_bounced_at <= dbNow`: this is a plain read with no transaction held around it, so
 * nothing stops it from running fractionally after `dbNow` was captured, and without that
 * bound it would also needlessly scan every hard-bounced delivery ever, not just this call's
 * own subscribers.
 */
async function fetchSummaryRows(db: DbOrTx, windowStart: Date, dbNow: Date): Promise<SummaryRow[]> {
  const { rows } = await db.execute<SummaryRow>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (subscriber_id) subscriber_id, action, detail, at
        FROM subscriber_history
       WHERE actor = ${BOUNCE_ACTOR}
         AND action IN ('bounce-recorded', 'bounce-disabled', 'bounce-flagged')
         AND at > ${windowStart} AND at <= ${dbNow}
       ORDER BY subscriber_id, at DESC
    ),
    latest_delivery AS (
      SELECT DISTINCT ON (subscriber_id) subscriber_id, bounce_status
        FROM deliveries
       WHERE subscriber_id IN (SELECT subscriber_id FROM latest)
         AND hard_bounced_at IS NOT NULL
         AND hard_bounced_at <= ${dbNow}
       ORDER BY subscriber_id, hard_bounced_at DESC
    )
    SELECT l.subscriber_id, s.email, l.action, l.detail, d.bounce_status
      FROM latest l
      JOIN subscribers s ON s.id = l.subscriber_id
      LEFT JOIN latest_delivery d ON d.subscriber_id = l.subscriber_id
     ORDER BY s.email
  `);
  return rows;
}

/** The outcome text (Global Constraints "Summary email"). `bounce-disabled`'s own history
 * `detail` already holds the exact "10/15d" bounces.ts wrote; `bounce-recorded` has no such
 * count of its own (its `detail` is just the status code) and needs `count` -- this
 * subscriber's *current* count of hard-bounced emails in the 15-day window
 * ({@link countBouncedEmails}), freshly computed rather than read off the history row, since a
 * subscriber can rack up several `bounce-recorded` rows before ever tripping the threshold. */
function outcomeFor(row: SummaryRow, count: number): string {
  if (row.action === "bounce-recorded") return `recorded (${count}/${THRESHOLD_WINDOW_DAYS}d)`;
  if (row.action === "bounce-disabled") return `disabled (${row.detail})`;
  return "flagged — media list member";
}

/** The address, hard/soft and status code, and the outcome (Global Constraints "Summary
 * email"). Every row here traces back to a hard bounce (the only kind bounces.ts ever writes
 * history for), so `hard` is always true; `status` falls back to the history row's own detail
 * for `bounce-recorded` (identically the status code bounces.ts wrote there) when no delivery
 * row survived to join against. A media-list member's whole line is wrapped in `<b>` in the
 * html part, as legacy did -- never in the text part, which has no markup at all. */
function formatLine(row: SummaryRow, outcome: string, mediaMember: boolean): { html: string; text: string } {
  const status = row.bounce_status ?? (row.action === "bounce-recorded" ? row.detail || null : null);
  const statusSuffix = status ? ` (${status})` : "";
  const text = `${row.email} - hard${statusSuffix}: ${outcome}`;
  const html = `${escapeHtml(row.email)} - hard${status ? ` (${escapeHtml(status)})` : ""}: ${escapeHtml(outcome)}`;
  return mediaMember ? { html: `<b>${html}</b>`, text } : { html, text };
}

function localDateLabel(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

type ClaimResult =
  | { kind: "busy" }
  | { kind: "not-due" }
  | { kind: "claimed"; lease: string; dbNow: Date; cutoff: Date; windowStart: Date };

/**
 * Claims the right to run today's summary, in one short transaction holding `nod_settings`
 * `FOR UPDATE` only for the handful of statements below -- never across the network calls
 * `runBounceSummaryIfDue` makes once claimed (modelled on `media-hub/sync.ts`'s
 * `claimOrResume`, minus its resumable-cursor machinery, which this has no use for).
 *
 * An active lease (`lease_until` still ahead of `dbNow`) means another invocation is already
 * working this: `"busy"`. Otherwise due is checked: `checked_at` null or earlier than today's
 * cutoff, *and* `dbNow` has actually reached that cutoff -- the second half is what keeps this
 * from ever firing before 08:00, including on the very first run ever (an expired/abandoned
 * lease is simply claimed afresh, same as a day nothing has touched at all -- there's no
 * cursor to resume, so a crash mid-run just means the next due check starts over from this
 * subscriber list as it stands then).
 */
async function claim(db: Db, timeZone: string, now?: TestClock): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const { rows: nowRows } = await tx.execute<{ now: string }>(sql`SELECT ${sqlNow(now)} AS now`);
    const dbNow = new Date(nowRows[0]!.now);
    const cutoff = todaysCutoff(dbNow, timeZone, BOUNCE_SUMMARY_HOUR);

    const { rows } = await tx.execute<{
      bounce_summary_at: string | null;
      bounce_summary_checked_at: string | null;
      bounce_summary_lease: string | null;
      bounce_summary_lease_until: string | null;
    }>(sql`
      SELECT bounce_summary_at, bounce_summary_checked_at, bounce_summary_lease, bounce_summary_lease_until
        FROM nod_settings WHERE id = 1 FOR UPDATE
    `);
    const row = rows[0];

    const leaseUntil = row?.bounce_summary_lease_until ? new Date(row.bounce_summary_lease_until) : null;
    const leaseActive = row?.bounce_summary_lease != null && leaseUntil !== null && leaseUntil.getTime() > dbNow.getTime();
    if (leaseActive) return { kind: "busy" };

    const checkedAt = row?.bounce_summary_checked_at ? new Date(row.bounce_summary_checked_at) : null;
    const due = (checkedAt === null || checkedAt.getTime() < cutoff.getTime()) && dbNow.getTime() >= cutoff.getTime();
    if (!due) return { kind: "not-due" };

    const lastAt = row?.bounce_summary_at ? new Date(row.bounce_summary_at) : null;
    const windowStart = lastAt ?? new Date(dbNow.getTime() - DAY_MS);

    const lease = randomUUID();
    await tx
      .update(nodSettings)
      .set({ bounceSummaryLease: lease, bounceSummaryLeaseUntil: new Date(dbNow.getTime() + LEASE_MS), updatedAt: sql`now()` })
      .where(eq(nodSettings.id, 1));
    return { kind: "claimed", lease, dbNow, cutoff, windowStart };
  });
}

/**
 * Stamps the outcome of a claimed run and releases its lease, in one short transaction guarded
 * by `WHERE bounce_summary_lease = lease`: a runner whose lease has since been taken over
 * (its own 5-minute window expired before it got here, and someone else has since claimed and
 * possibly already finished) matches no row, so this is a no-op rather than clobbering
 * whatever the new holder already wrote.
 *
 * `stamp` is null on a thrown error: the lease alone is cleared, leaving both `checked_at` and
 * `bounce_summary_at` exactly where they were, so the next due check retries the whole thing.
 * A successful run with nothing to report stamps `checkedAt` alone; a successful send stamps
 * both.
 */
async function finish(db: Db, lease: string, stamp: { checkedAt: Date; at?: Date } | null): Promise<void> {
  await db
    .update(nodSettings)
    .set({
      bounceSummaryLease: null,
      bounceSummaryLeaseUntil: null,
      ...(stamp ? { bounceSummaryCheckedAt: stamp.checkedAt, ...(stamp.at ? { bounceSummaryAt: stamp.at } : {}) } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(nodSettings.id, 1), eq(nodSettings.bounceSummaryLease, lease)));
}

/**
 * Runs the daily bounce summary if it's due (Global Constraints "Summary email"): claim (see
 * {@link claim}), then work with no transaction held (fetch the rows, call
 * `distribution.bounceStats`, then `distribution.send` -- each of which can take up to the
 * full request timeout), then {@link finish}.
 *
 * `to` unset means no operator inbox is configured for this -- a no-op, same shape as
 * settings.ts's own `opsEmail: null` case, checked before ever touching the database.
 *
 * The window is `(windowStart, dbNow]`, where `windowStart` is the last run's own `dbNow` (not
 * its `cutoff` -- the two can differ by however late this tick ran past 08:00) or, on the very
 * first run, 24h before `dbNow`.
 *
 * An *ignored-only* window -- no subscriber lines and no unmatched bounces, only non-bounce
 * mail Distribution classified `ignored` -- sends no email. Only bounces (matched or not)
 * count as "there were bounces"; `ignored` alone never does.
 *
 * `now` is a test hook (see `@gcpe/db-kit`'s `TestClock`): production call sites never pass
 * one.
 */
export async function runBounceSummaryIfDue(
  db: Db,
  distribution: Pick<DistributionClient, "send" | "bounceStats">,
  timeZone: string,
  to: string | null,
  now?: TestClock,
): Promise<{ sent: boolean; lines: number }> {
  if (!to) return { sent: false, lines: 0 };

  const claimed = await claim(db, timeZone, now);
  if (claimed.kind !== "claimed") return { sent: false, lines: 0 };
  const { lease, dbNow, cutoff, windowStart } = claimed;

  try {
    const rows = await fetchSummaryRows(db, windowStart, dbNow);
    const lines: { html: string; text: string }[] = [];
    for (const row of rows) {
      const count = row.action === "bounce-recorded" ? await countBouncedEmails(db, row.subscriber_id) : 0;
      const mediaMember = await hasMediaMemberships(db, row.subscriber_id);
      lines.push(formatLine(row, outcomeFor(row, count), mediaMember));
    }

    const stats = await distribution.bounceStats(windowStart.toISOString(), dbNow.toISOString());
    if (lines.length === 0 && stats.unmatched === 0) {
      await finish(db, lease, { checkedAt: cutoff });
      return { sent: false, lines: 0 };
    }

    const dateLabel = localDateLabel(cutoff, timeZone);
    const generatedAt = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "long", timeStyle: "short" }).format(dbNow);
    const subject = `News On Demand - Bounce Manager - ${dateLabel}`;

    const htmlLines = lines.length > 0 ? lines.map((l) => `<p>${l.html}</p>`).join("\n") : "<p>No bounced subscribers in this window.</p>";
    const textLines = lines.length > 0 ? lines.map((l) => l.text).join("\n") : "No bounced subscribers in this window.";
    const html = `${htmlLines}\n<p>Unmatched: ${stats.unmatched}; ignored: ${stats.ignored}.</p>\n<p>Generated on ${escapeHtml(generatedAt)} (${escapeHtml(timeZone)}).</p>`;
    const text = `${textLines}\nUnmatched: ${stats.unmatched}; ignored: ${stats.ignored}.\nGenerated on ${generatedAt} (${timeZone}).`;

    await distribution.send({
      priority: "system",
      idempotencyKey: `nod-bounce-summary-${dateLabel}`,
      subject,
      html,
      text,
      headers: {},
      recipients: [{ email: to, substitutions: {} }],
    });

    await finish(db, lease, { checkedAt: cutoff, at: dbNow });
    return { sent: true, lines: lines.length };
  } catch (e) {
    await finish(db, lease, null);
    throw e;
  }
}

/** Same start/stop shape as `digest.ts`'s `startDigestLoop` and `media-hub/sync.ts`'s
 * `startMediaSyncLoop`: a once-a-minute no-op call until the tenant's wall clock actually
 * reaches {@link BOUNCE_SUMMARY_HOUR} for a cutoff not already checked. Errors are logged
 * (`safeErrorLabel`: no bound values, so never an address, even when the thrown error's own
 * message happens to carry one) and never thrown out of the loop. */
export function startBounceSummaryLoop(opts: {
  db: Db;
  distribution: Pick<DistributionClient, "send" | "bounceStats">;
  timeZone: string;
  to: string | null;
  intervalMs?: number;
  now?: TestClock;
}): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = runBounceSummaryIfDue(opts.db, opts.distribution, opts.timeZone, opts.to, opts.now)
      .catch((e) => console.error("[nod] bounce summary failed", safeErrorLabel(e)))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 60_000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
