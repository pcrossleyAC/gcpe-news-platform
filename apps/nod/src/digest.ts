import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { Db, Tx } from "@gcpe/db-kit";
import { matchesItem } from "./matching";
import { itemCategories, renderDigest, type Rendered, type RenderItem, type RenderOptions } from "./render";
import { digestRuns, items, nodSettings, sendJobs } from "./db/schema";
import { safeErrorLabel } from "./subscribe/journeys";

export const DIGEST_HOUR = 17;

/** Every digest job of one run has a key starting with this; the digest-run report finds a run's
 * jobs by it. */
export function digestJobKeyPrefix(cutoff: Date): string {
  return `digest:${cutoff.toISOString()}:`;
}
/** toISOString is always 24 characters ("2026-10-07T00:00:00.000Z"), so every prefix is 32. */
export const DIGEST_JOB_PREFIX_LENGTH = 32;

function localDateParts(d: Date, timeZone: string): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), day: get("day") };
}

/**
 * `hour`:00 local on the local date of `dbNow` -- always *today's*, even if that instant is
 * still ahead of `dbNow` (unlike {@link dailyCutoff}). Uses the same wall-clock->instant
 * conversion as the rest of the platform (Node's tzdata, asserted at startup via
 * `assertTimeZoneRules`), never Postgres's (global constraints: clocks).
 *
 * `wallClockToInstant`'s contract (packages/config/src/timezone.ts): it takes a `Date` whose
 * *UTC* fields hold the wall-clock fields meant for `timeZone`. `Date.UTC(y, m - 1, day, hour,
 * 0, 0)` builds exactly that, so no adaptation is needed here.
 */
export function todaysCutoff(dbNow: Date, timeZone: string, hour: number): Date {
  const { y, m, day } = localDateParts(dbNow, timeZone);
  return wallClockToInstant(new Date(Date.UTC(y, m - 1, day, hour, 0, 0)), timeZone);
}

/**
 * `hour`:00 local on the local date of `dbNow`, or the day before if that is still ahead.
 */
export function dailyCutoff(dbNow: Date, timeZone: string, hour: number): Date {
  const today = todaysCutoff(dbNow, timeZone, hour);
  if (today.getTime() <= dbNow.getTime()) return today;
  const { y, m, day } = localDateParts(dbNow, timeZone);
  return wallClockToInstant(new Date(Date.UTC(y, m - 1, day - 1, hour, 0, 0)), timeZone);
}

/** The 17:00 daily digest cutoff -- a thin wrapper over {@link dailyCutoff} so its own tests
 * stay unchanged. */
export function digestCutoff(dbNow: Date, timeZone: string): Date {
  return dailyCutoff(dbNow, timeZone, DIGEST_HOUR);
}

const DAY_MS = 24 * 3_600_000;

/** One group of subscribers who, this run, are due exactly the same set of items (grouping is
 * by the subscriber's resolved item keys, not by list key, so two subscribers who happen to
 * subscribe to different lists that matched exactly the same items still share one job — same
 * as two subscribers on the identical lists). */
interface DigestGroup {
  keys: string[];
  subscriberIds: string[];
}

/** This group's items, loaded in `publishedAt` order (the order `renderDigest` lists them in —
 * it trusts the caller's order and does not sort), each with its resolved categories attached. */
async function loadGroupItems(tx: Tx, keys: string[]): Promise<RenderItem[]> {
  const rows = await tx.select().from(items).where(inArray(items.key, keys)).orderBy(items.publishedAt, items.key);
  // Sequential, not Promise.all: a transaction is one connection, so concurrent queries against
  // the same `tx` would just serialise at the driver anyway (and node-postgres warns about it).
  const renderItems: RenderItem[] = [];
  for (const row of rows) {
    const categories = await itemCategories(tx, row.listKeys);
    renderItems.push({ key: row.key, title: row.title, summary: row.summary, url: row.url, publishedAt: row.publishedAt, categories });
  }
  return renderItems;
}

/** Renders a digest's content from exactly the given item keys (`loadGroupItems`' own order
 * and categories, through `renderDigest`). Used both to build a group's job here and by the
 * sender (send-jobs.ts) to re-render a digest job already built once some of its items are
 * withdrawn before it's sent. */
export async function renderDigestItems(tx: Tx, keys: string[], render: RenderOptions): Promise<Rendered> {
  const renderItems = await loadGroupItems(tx, keys);
  return renderDigest(renderItems, render);
}

/** Builds and inserts one group's digest job, recipients and deliveries. */
async function createDigestJob(tx: Tx, cutoff: Date, group: DigestGroup, render: RenderOptions): Promise<void> {
  const rendered = await renderDigestItems(tx, group.keys, render);
  const hash = createHash("sha256").update(group.keys.join(",")).digest("hex").slice(0, 16);
  const jobKey = `${digestJobKeyPrefix(cutoff)}${hash}`;

  const [job] = await tx
    .insert(sendJobs)
    .values({ jobKey, kind: "digest", priority: "digest", itemKey: null, subject: rendered.subject, html: rendered.html, text: rendered.text })
    .returning({ id: sendJobs.id });

  await tx.execute(sql`
    INSERT INTO job_recipients (job_id, subscriber_id)
    SELECT ${job!.id}::uuid, unnest(${sql.param(group.subscriberIds)}::uuid[])
    ON CONFLICT DO NOTHING
  `);

  // Controller ruling: the digest does not lock against concurrent As-It-Happens sends. The
  // constraint is one-directional (no As-It-Happens after a digest delivery) -- a concurrent
  // As-It-Happens + digest gives the same result as "As-It-Happens first, then digest", which
  // is valid because the digest doesn't exclude items already sent As-It-Happens. No lock is
  // taken here on purpose.
  await tx.execute(sql`
    INSERT INTO deliveries (item_key, subscriber_id, mode, job_id)
    SELECT k, s, 'digest', ${job!.id}::uuid
      FROM unnest(${sql.param(group.keys)}::text[]) AS k
     CROSS JOIN unnest(${sql.param(group.subscriberIds)}::uuid[]) AS s
    ON CONFLICT DO NOTHING
  `);
}

/**
 * Runs the 17:00 daily digest if it's due, in one transaction (global constraints: exactly-once
 * -- at most one digest per subscriber per cutoff, and the cutoff is computed from the
 * database's own `now()`, never Postgres's tzdata):
 *
 * 1. `cutoff` is computed from the database's `now()` and `timeZone` (never Postgres's own
 *    tzdata -- see {@link digestCutoff}).
 * 2. `nod_settings` is read `FOR UPDATE`, serialising concurrent calls on the one settings row:
 *    if its `last_digest_cutoff` is already at or past `cutoff`, this cutoff has already run.
 * 3. `digest_runs` is inserted for `cutoff`, `ON CONFLICT DO NOTHING` -- a second defence (on
 *    top of the `FOR UPDATE` serialisation above) against ever running the same cutoff twice.
 * 4. Subscribers are grouped by the exact set of matching items they're due (same grouping
 *    query as the brief: `matchesItem`, the same "all news" rule As-It-Happens and
 *    `countSubscribers` use), excluding advisories, non-subscriber items, withdrawn items and
 *    items outside the window, and subscribers who aren't `active` or didn't opt into `digest`.
 * 5. Each group gets one `send_jobs` row (kind `digest`, priority `digest`), its `job_recipients`
 *    and one `deliveries` row per item per subscriber in the group.
 * 6. `digest_runs`' counts and `nod_settings.last_digest_cutoff` are updated to `cutoff`.
 */
export async function runDigestIfDue(
  db: Db,
  timeZone: string,
  render: RenderOptions,
): Promise<{ ran: boolean; cutoff: string | null; subscribers: number; groups: number }> {
  return db.transaction(async (tx) => {
    // drizzle-orm's node-postgres driver deliberately turns off its own timestamp/timestamptz
    // parsing for a raw `execute()` (it leaves that to its query-builder's column-aware
    // mapping instead, which a raw `sql` template has none of) -- so both of these come back
    // as Postgres's own text format (e.g. "2026-10-05 23:17:37.411027-07"), not a Date, and
    // must be parsed here.
    const { rows: nowRows } = await tx.execute<{ now: string }>(sql`SELECT now() AS now`);
    const dbNow = new Date(nowRows[0]!.now);
    const cutoff = digestCutoff(dbNow, timeZone);

    // Locks the one settings row for the lifetime of this transaction, serialising a
    // concurrent call onto the same row: whichever commits first updates last_digest_cutoff,
    // so the other -- once unblocked -- sees it already >= cutoff and returns ran: false below.
    const { rows: settingsRows } = await tx.execute<{ last_digest_cutoff: string | null }>(
      sql`SELECT last_digest_cutoff FROM nod_settings WHERE id = 1 FOR UPDATE`,
    );
    const lastDigestCutoff = settingsRows[0]?.last_digest_cutoff ? new Date(settingsRows[0].last_digest_cutoff) : null;
    if (lastDigestCutoff && lastDigestCutoff.getTime() >= cutoff.getTime()) {
      return { ran: false, cutoff: cutoff.toISOString(), subscribers: 0, groups: 0 };
    }

    const windowStart = lastDigestCutoff ?? new Date(cutoff.getTime() - DAY_MS);

    const runRows = await tx
      .insert(digestRuns)
      .values({ cutoff, windowStart })
      .onConflictDoNothing({ target: digestRuns.cutoff })
      .returning({ cutoff: digestRuns.cutoff });
    if (runRows.length === 0) {
      // Another process already has this cutoff's run.
      return { ran: false, cutoff: cutoff.toISOString(), subscribers: 0, groups: 0 };
    }

    const { rows: groupRows } = await tx.execute<{ keys: string[]; subscriber_ids: string[] }>(sql`
      WITH win AS (
        SELECT key, list_keys FROM items
         WHERE kind = 'release' AND to_subscribers AND withdrawn_at IS NULL
           AND COALESCE(post_kind, '') <> 'advisories'
           AND published_at > ${windowStart} AND published_at <= ${cutoff}),
      m AS (
        SELECT DISTINCT s.id AS subscriber_id, w.key
          FROM subscribers s
          JOIN subscriptions sub ON sub.subscriber_id = s.id
          JOIN win w ON ${matchesItem(sql`sub.list_key`, sql`w.list_keys`)}
         WHERE s.status = 'active' AND s.digest),
      per AS (SELECT subscriber_id, array_agg(key ORDER BY key) AS keys FROM m GROUP BY subscriber_id)
      SELECT keys, array_agg(subscriber_id ORDER BY subscriber_id) AS subscriber_ids FROM per GROUP BY keys
    `);

    let totalSubscribers = 0;
    for (const row of groupRows) {
      const group: DigestGroup = { keys: row.keys, subscriberIds: row.subscriber_ids };
      totalSubscribers += group.subscriberIds.length;
      await createDigestJob(tx, cutoff, group, render);
    }

    await tx.update(digestRuns).set({ subscribers: totalSubscribers, groups: groupRows.length }).where(eq(digestRuns.cutoff, cutoff));
    await tx.update(nodSettings).set({ lastDigestCutoff: cutoff, updatedAt: sql`now()` }).where(eq(nodSettings.id, 1));

    return { ran: true, cutoff: cutoff.toISOString(), subscribers: totalSubscribers, groups: groupRows.length };
  });
}

/**
 * Controller ruling: the standalone NoD image and STACK_LOOPS=true starts only the job
 * sender loop (send-jobs.ts's startJobSender); without this, nothing ever calls
 * {@link runDigestIfDue} outside of the once-per-process-startup `workers.digest` hook, so no
 * digest is ever sent. This runs the same worker function, once a minute (a no-op call until
 * the tenant's wall clock actually reaches DIGEST_HOUR for a cutoff not already run -- see
 * runDigestIfDue), same start/stop shape as startJobSender (send-jobs.ts): a tick is skipped
 * while the previous one is still running, and the returned stop function clears the interval
 * and awaits any run still in flight. Errors are logged (safeErrorLabel: no bound values) and
 * never thrown out of the loop -- one failed tick must not take down the process or stop later
 * ticks from being tried.
 */
export function startDigestLoop(opts: { db: Db; timeZone: string; render: RenderOptions; intervalMs?: number }): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = runDigestIfDue(opts.db, opts.timeZone, opts.render)
      .catch((e) => console.error("[nod] digest failed", safeErrorLabel(e)))
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
