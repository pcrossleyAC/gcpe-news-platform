/**
 * Outgoing news email for Operations (suite review N3, owner 2026-10-31): what a pause is holding,
 * what failed, and cancelling held email before a resume sends it.
 *
 * "Held" is every `pending` send job: while NoD is paused the sender claims nothing
 * (send-jobs.ts `sendDueJobs`), so they all wait; while it's running the list is normally empty
 * or holds jobs waiting to retry. "Failed" is a job the sender gave up on (send-jobs.ts: not
 * retryable, or 24 hours old), which until now only reached the server log.
 */
import { sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { writeOpsLog } from "./settings";

/** How far back failed email is shown: long enough to notice, short enough to stay relevant. */
export const FAILED_DAYS = 30;
/** At most this many failed rows, newest first. */
export const FAILED_LIMIT = 50;

export type OutgoingKind = "as_it_happens" | "emergency" | "media" | "digest";

/** One release's email of one kind, or one daily digest run (its jobs together). */
export interface OutgoingGroup {
  /** What Cancel sends back: the send jobs in this row. */
  jobIds: string[];
  kind: OutgoingKind;
  /** The release or alert title; null for a digest. */
  title: string | null;
  itemKey: string | null;
  /** A digest run's cutoff (its 5:00 pm), else null. */
  digestCutoff: string | null;
  /** How many releases a digest row carries; 1 otherwise. */
  releases: number;
  /** Held: active recipients, the ones it would go to now. Failed: everyone it was for. */
  emails: number;
  /** When the oldest job in the row was made. */
  createdAt: string;
  attempts: number;
  /** The latest job's last error as the sender recorded it (Distribution's own words). */
  lastError: string | null;
}

export interface OutgoingStatus {
  held: { emails: number; releases: number; oldestAt: string | null; groups: OutgoingGroup[] };
  failed: OutgoingGroup[];
}

/** NoD's sending isn't paused, so held email may be on its way: nothing is cancelled. → 409. */
export class NotPausedError extends Error {
  constructor() {
    super("not-paused");
  }
}

type JobRow = {
  id: string;
  kind: string;
  item_key: string | null;
  job_key: string;
  created_at: string | Date;
  attempts: number;
  last_error: string | null;
  title: string | null;
  emails: number;
  item_keys: string[] | null;
};

const iso = (d: string | Date) => new Date(d).toISOString();

/** One query per status: each job with its title, recipient count and (for a digest) items. */
async function jobRows(db: DbOrTx, status: "pending" | "failed", activeOnly: boolean): Promise<JobRow[]> {
  const window = status === "failed" ? sql`AND j.created_at > now() - ${`${FAILED_DAYS} days`}::interval` : sql``;
  const { rows } = await db.execute<JobRow>(sql`
    SELECT j.id, j.kind, j.item_key, j.job_key, j.created_at, j.attempts, j.last_error, i.title,
           (SELECT count(*) FROM job_recipients r JOIN subscribers s ON s.id = r.subscriber_id
             WHERE r.job_id = j.id ${activeOnly ? sql`AND s.status = 'active'` : sql``})::int AS emails,
           CASE WHEN j.kind = 'digest'
                THEN (SELECT array_agg(DISTINCT d.item_key) FROM deliveries d WHERE d.job_id = j.id) END AS item_keys
      FROM send_jobs j
      LEFT JOIN items i ON i.key = j.item_key
     WHERE j.status = ${status} ${window}
     ORDER BY j.created_at, j.id`);
  return rows;
}

/** Digest jobs of one run share their key's first 32 characters (digest.ts). */
const groupKey = (r: JobRow) => (r.kind === "digest" ? r.job_key.slice(0, 32) : r.job_key);

function group(rows: JobRow[]): (OutgoingGroup & { itemKeys: Set<string> })[] {
  const out = new Map<string, OutgoingGroup & { itemKeys: Set<string> }>();
  for (const r of rows) {
    const key = groupKey(r);
    const keys = r.kind === "digest" ? (r.item_keys ?? []) : r.item_key ? [r.item_key] : [];
    const g = out.get(key);
    if (!g) {
      out.set(key, {
        jobIds: [r.id],
        kind: r.kind as OutgoingKind,
        title: r.kind === "digest" ? null : r.title,
        itemKey: r.item_key,
        digestCutoff: r.kind === "digest" ? r.job_key.slice(7, 31) : null,
        releases: 0,
        emails: r.emails,
        createdAt: iso(r.created_at),
        attempts: r.attempts,
        lastError: r.last_error,
        itemKeys: new Set(keys),
      });
      continue;
    }
    g.jobIds.push(r.id);
    g.emails += r.emails;
    g.attempts = Math.max(g.attempts, r.attempts);
    if (r.last_error) g.lastError = r.last_error;
    for (const k of keys) g.itemKeys.add(k);
  }
  for (const g of out.values()) g.releases = g.kind === "digest" ? g.itemKeys.size : 1;
  return [...out.values()];
}

const strip = ({ itemKeys: _, ...g }: OutgoingGroup & { itemKeys: Set<string> }): OutgoingGroup => g;

export async function getOutgoing(db: DbOrTx): Promise<OutgoingStatus> {
  const held = group(await jobRows(db, "pending", true));
  const failed = group(await jobRows(db, "failed", false))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, FAILED_LIMIT);
  const items = new Set<string>();
  for (const g of held) for (const k of g.itemKeys) items.add(k);
  return {
    held: {
      emails: held.reduce((n, g) => n + g.emails, 0),
      releases: items.size,
      oldestAt: held[0]?.createdAt ?? null,
      groups: held.map(strip),
    },
    failed: failed.map(strip),
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Cancels the given send jobs that are still held, so a resume won't send them. Only while NoD is
 * paused: the settings row is read `FOR SHARE`, so a concurrent resume waits for this to commit.
 * A job is cancelled only if it's `pending` and not claimed by the sender (no live lock), so one
 * claimed just before the pause is left to finish; already sent, failed or cancelled jobs are
 * skipped. Cancelled jobs keep their delivery rows (never handed off), so the reports still show
 * those emails as not sent. Writes one operations-log row when anything was cancelled.
 */
export async function cancelHeldEmail(db: Db, jobIds: string[], actor: string): Promise<{ cancelledJobs: number; cancelledEmails: number }> {
  if (jobIds.length === 0) return { cancelledJobs: 0, cancelledEmails: 0 };
  return db.transaction(async (tx) => {
    const { rows: settings } = await tx.execute<{ paused: boolean }>(sql`SELECT paused FROM nod_settings WHERE id = 1 FOR SHARE`);
    if (!settings[0]?.paused) throw new NotPausedError();
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE send_jobs SET status = 'cancelled', locked_until = NULL
       WHERE id = ANY(${sql.param(jobIds)}::uuid[])
         AND status = 'pending'
         AND (locked_until IS NULL OR locked_until < now())
      RETURNING id`);
    if (rows.length === 0) return { cancelledJobs: 0, cancelledEmails: 0 };
    const { rows: counted } = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM job_recipients r JOIN subscribers s ON s.id = r.subscriber_id
       WHERE r.job_id = ANY(${sql.param(rows.map((r) => r.id))}::uuid[]) AND s.status = 'active'`);
    const emails = counted[0]?.n ?? 0;
    await writeOpsLog(tx, actor, "held-email-cancelled", `${plural(rows.length, "send job")}, ${plural(emails, "email")}`);
    return { cancelledJobs: rows.length, cancelledEmails: emails };
  });
}
