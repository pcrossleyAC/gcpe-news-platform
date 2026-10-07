import { eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import { escapeHtml } from "@gcpe/http-kit";
import { BOUNCE_ACTOR, countBouncedEmails, THRESHOLD_WINDOW_DAYS } from "./bounces";
import { dailyCutoff } from "./digest";
import type { DistributionClient } from "./distribution-client";
import { nodSettings } from "./db/schema";
import { hasMediaMemberships } from "./media-members";
import { safeErrorLabel } from "./subscribe/journeys";

/** Daily at 08:00 BC time (Global Constraints "Summary email"), the same `dailyCutoff` shape
 * as the digest (17:00) and the Media Hub sync (02:00). */
export const BOUNCE_SUMMARY_HOUR = 8;

const DAY_MS = 24 * 3_600_000;

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
 */
async function fetchSummaryRows(tx: Tx, windowStart: Date, dbNow: Date): Promise<SummaryRow[]> {
  const { rows } = await tx.execute<SummaryRow>(sql`
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
       WHERE hard_bounced_at IS NOT NULL
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

/**
 * Runs the daily bounce summary if it's due (Global Constraints "Summary email"), in one
 * transaction -- the same claim-on-the-settings-row shape as the digest's own
 * `runDigestIfDue` (digest.ts): `nod_settings` is locked `FOR UPDATE` for the whole call, so a
 * concurrent call blocks until this one commits (or rolls back) and then sees the result,
 * giving "concurrent runs -> one email" for free, the same way the digest gets "one digest per
 * cutoff" from the same lock.
 *
 * `to` unset means no operator inbox is configured for this -- a no-op, same shape as
 * settings.ts's own `opsEmail: null` case, checked before ever touching the database.
 *
 * The window is `(windowStart, dbNow]`, where `windowStart` is the last run's own `dbNow` (not
 * its `cutoff` -- the two can differ by however late this tick ran past 08:00) or, on the very
 * first run, 24h before `dbNow`. `bounce_summary_at` is only ever set to this run's own
 * `dbNow` on a send that actually happened: a run with nothing to report, or whose
 * `distribution.send` throws, leaves it untouched -- rolling the whole transaction back on a
 * throw -- so the next tick's window simply grows to cover what this one didn't send, rather
 * than ever silently dropping it.
 */
export async function runBounceSummaryIfDue(
  db: Db,
  distribution: Pick<DistributionClient, "send" | "bounceStats">,
  timeZone: string,
  to: string | null,
): Promise<{ sent: boolean; lines: number }> {
  if (!to) return { sent: false, lines: 0 };

  return db.transaction(async (tx) => {
    const { rows: nowRows } = await tx.execute<{ now: string }>(sql`SELECT now() AS now`);
    const dbNow = new Date(nowRows[0]!.now);
    const cutoff = dailyCutoff(dbNow, timeZone, BOUNCE_SUMMARY_HOUR);

    const { rows: settingsRows } = await tx.execute<{ bounce_summary_at: string | null }>(
      sql`SELECT bounce_summary_at FROM nod_settings WHERE id = 1 FOR UPDATE`,
    );
    const lastAt = settingsRows[0]?.bounce_summary_at ? new Date(settingsRows[0].bounce_summary_at) : null;
    if (lastAt && lastAt.getTime() >= cutoff.getTime()) {
      return { sent: false, lines: 0 };
    }

    const windowStart = lastAt ?? new Date(dbNow.getTime() - DAY_MS);
    const rows = await fetchSummaryRows(tx, windowStart, dbNow);

    const lines: { html: string; text: string }[] = [];
    for (const row of rows) {
      const count = row.action === "bounce-recorded" ? await countBouncedEmails(tx, row.subscriber_id) : 0;
      const mediaMember = await hasMediaMemberships(tx, row.subscriber_id);
      lines.push(formatLine(row, outcomeFor(row, count), mediaMember));
    }

    const stats = await distribution.bounceStats(windowStart.toISOString());
    if (lines.length === 0 && stats.unmatched === 0 && stats.ignored === 0) {
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

    await tx.update(nodSettings).set({ bounceSummaryAt: dbNow, updatedAt: sql`now()` }).where(eq(nodSettings.id, 1));
    return { sent: true, lines: lines.length };
  });
}

/** Same start/stop shape as `digest.ts`'s `startDigestLoop` and `media-hub/sync.ts`'s
 * `startMediaSyncLoop`: a once-a-minute no-op call until the tenant's wall clock actually
 * reaches {@link BOUNCE_SUMMARY_HOUR} for a cutoff not already run. Errors are logged
 * (`safeErrorLabel`: no bound values, so never an address) and never thrown out of the loop. */
export function startBounceSummaryLoop(opts: {
  db: Db;
  distribution: Pick<DistributionClient, "send" | "bounceStats">;
  timeZone: string;
  to: string | null;
  intervalMs?: number;
}): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = runBounceSummaryIfDue(opts.db, opts.distribution, opts.timeZone, opts.to)
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
