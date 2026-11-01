import { isStatementTimeout } from "@gcpe/db-kit";
import type { OutboxAdmin } from "@gcpe/events";
import type { NodHealth } from "../../nod/src/health";

/**
 * Suite review O2.1 (owner 2026-10-31): `/stack/health`'s `checks` block — the background work the
 * database pings can't see. Each check is `{ ok, …its numbers }`; any red one makes the stack
 * report `status: "degraded"` (still HTTP 200, so load balancers and deploy checks carry on).
 * docs/deploy/windows.md §7 lists every check for the uptime monitor.
 *
 * The limits below are deliberately generous: a red check should mean someone needs to look.
 */
export const HEALTH_LIMITS = {
  /** An app's oldest waiting delivery: the dispatcher retries for 24 hours with backoff of up to an
   * hour, so an hour's wait means the receiving app has been refusing it for a while. */
  outboxOldestPendingMinutes: 60,
  /** Undelivered updates queued within this many days keep their outbox red; older ones are still
   * counted and still listed on Undelivered updates, but no longer alert. */
  undeliveredRecentDays: 7,
  /** A scheduled release this many minutes past its time and still not published is overdue. */
  overdueGraceMinutes: 10,
  /** The digest runs once a day at 17:00 BC time. */
  digestMaxMinutes: 26 * 60,
  /** The emergency feed is read every 5 minutes. */
  emergencyFeedMaxMinutes: 30,
  /** The Media Hub sync runs nightly. */
  mediaSyncMaxMinutes: 26 * 60,
  /** NoD's send loop runs every few seconds (every minute under the scheduler's tick). */
  sendLoopMaxMinutes: 15,
  /** A whole-site rebuild can queue every page (about eight hours for 100,000 posts,
   * docs/parity/url-cutover-runbook.md), so length alone isn't a problem: a page waiting longer
   * than that means the builder isn't keeping up. */
  rebuildQueueOldestMaxMinutes: 12 * 60,
  /** Fix round 2, I2: each check's queries are cancelled after this long, and the answer stops
   * waiting for it a moment later, so /stack/health stays well inside the 10 s a deploy's health
   * wait allows. A check past it reports "timed out" with `ok: null` (unknown), not red. */
  checkTimeoutMs: 2_000,
};

export type HealthLimits = typeof HEALTH_LIMITS;

/** `ok: null` is unknown (timed out): it neither turns the answer degraded nor passes as green. */
export type Check = { ok: boolean | null } & Record<string, number | boolean | string | null>;

/** Each source gets the time limit its queries must run under (`withStatementTimeout`). */
export interface OpsSources {
  outboxes: { name: string; outbox: Pick<OutboxAdmin, "health"> }[];
  overdueScheduled(graceMs: number, timeoutMs: number): Promise<{ count: number; oldestMinutes: number | null }>;
  nod(timeoutMs: number): Promise<NodHealth>;
  rebuildQueue(timeoutMs: number): Promise<{ pages: number; oldestMinutes: number | null }>;
  /** Minutes since this process started: "never ran yet" is only red once it has been up longer than the limit. */
  uptimeMinutes(): number;
}

/** Never the error itself: it can carry a connection string or a query's values. */
const UNREADABLE: Check = { ok: false, error: "couldn't check" };
/** Fix round 2, I2: took longer than HEALTH_LIMITS.checkTimeoutMs; unknown, not red. */
const TIMED_OUT: Check = { ok: null, error: "timed out" };
const failed = (v: unknown): v is Check => v === UNREADABLE || v === TIMED_OUT;

/** The source's answer; or TIMED_OUT when the database cancelled it, or it didn't answer in time; or UNREADABLE. */
async function readOr<T>(read: () => Promise<T>, timeoutMs: number): Promise<T | Check> {
  let timer: NodeJS.Timeout | undefined;
  // A moment past the database's own limit, for a source stuck before its query (a busy pool).
  const late = new Promise<Check>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs + 500);
  });
  try {
    return await Promise.race([read(), late]);
  } catch (e) {
    return isStatementTimeout(e) ? TIMED_OUT : UNREADABLE;
  } finally {
    clearTimeout(timer);
  }
}

/** Within `max` minutes; a thing that never ran is late only once the process has been up longer than `max`. */
const fresh = (minutesAgo: number | null, max: number, uptime: number) => (minutesAgo === null ? uptime <= max : minutesAgo <= max);

export async function runOpsChecks(s: OpsSources, L: HealthLimits = HEALTH_LIMITS): Promise<Record<string, Check>> {
  const uptime = s.uptimeMinutes();
  const recentMs = L.undeliveredRecentDays * 24 * 3_600_000;
  const t = L.checkTimeoutMs;
  const [outboxes, overdue, nod, queue] = await Promise.all([
    Promise.all(s.outboxes.map(async (o) => ({ name: o.name, health: await readOr(() => o.outbox.health({ recentMs, timeoutMs: t }), t) }))),
    readOr(() => s.overdueScheduled(L.overdueGraceMinutes * 60_000, t), t),
    readOr(() => s.nod(t), t),
    readOr(() => s.rebuildQueue(t), t),
  ]);

  const checks: Record<string, Check> = {};
  for (const { name, health: h } of outboxes) {
    // Fix round 1, N5: every field named, never spread — this answer is public on SiteGround.
    // Replaced and dismissed undelivered updates never turn it red (fix round 1, I1/M1).
    checks[`outbox.${name}`] = failed(h)
      ? h
      : {
          ok: (h.oldestPendingMinutes ?? 0) <= L.outboxOldestPendingMinutes && h.recentUndelivered === 0,
          pending: h.pending,
          oldestPendingMinutes: h.oldestPendingMinutes,
          undelivered: h.undelivered,
          replaced: h.replaced,
          recentUndelivered: h.recentUndelivered,
        };
  }
  checks["releases.overdue"] = failed(overdue) ? overdue : { ok: overdue.count === 0, count: overdue.count, oldestMinutes: overdue.oldestMinutes };
  if (!failed(nod)) {
    checks["nod.digest"] = { ok: fresh(nod.digestMinutesAgo, L.digestMaxMinutes, uptime), minutesSinceLastRun: nod.digestMinutesAgo };
    if (nod.emergencyFeed.on) {
      const f = nod.emergencyFeed;
      checks["nod.emergency-feed"] = { ok: f.lastCheckOk !== false && fresh(f.minutesSinceLastCheck, L.emergencyFeedMaxMinutes, uptime), minutesSinceLastCheck: f.minutesSinceLastCheck, lastCheckOk: f.lastCheckOk };
    }
    if (nod.mediaSync.on) {
      const m = nod.mediaSync;
      checks["nod.media-sync"] = { ok: !m.lastRunFailed && fresh(m.minutesSinceLastSuccess, L.mediaSyncMaxMinutes, uptime), minutesSinceLastSuccess: m.minutesSinceLastSuccess, lastRunFailed: m.lastRunFailed };
    }
    checks["nod.send-loop"] = { ok: fresh(nod.sendLoopMinutesAgo, L.sendLoopMaxMinutes, uptime), minutesSinceLastRun: nod.sendLoopMinutesAgo };
  } else {
    checks["nod.digest"] = nod;
    checks["nod.send-loop"] = nod;
  }
  checks["site.rebuild-queue"] = failed(queue) ? queue : { ok: (queue.oldestMinutes ?? 0) <= L.rebuildQueueOldestMaxMinutes, pages: queue.pages, oldestMinutes: queue.oldestMinutes };
  return checks;
}
