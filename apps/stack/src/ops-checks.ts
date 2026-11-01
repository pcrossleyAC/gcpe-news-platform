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
} as const;

export type Check = { ok: boolean } & Record<string, number | boolean | string | null>;

export interface OpsSources {
  outboxes: { name: string; outbox: Pick<OutboxAdmin, "health"> }[];
  overdueScheduled(graceMs: number): Promise<{ count: number; oldestMinutes: number | null }>;
  nod(): Promise<NodHealth>;
  rebuildQueue(): Promise<{ pages: number; oldestMinutes: number | null }>;
  /** Minutes since this process started: "never ran yet" is only red once it has been up longer than the limit. */
  uptimeMinutes(): number;
}

/** Never the error itself: it can carry a connection string or a query's values. */
const UNREADABLE: Check = { ok: false, error: "couldn't check" };

async function readOr<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Within `max` minutes; a thing that never ran is late only once the process has been up longer than `max`. */
const fresh = (minutesAgo: number | null, max: number, uptime: number) => (minutesAgo === null ? uptime <= max : minutesAgo <= max);

export async function runOpsChecks(s: OpsSources): Promise<Record<string, Check>> {
  const L = HEALTH_LIMITS;
  const uptime = s.uptimeMinutes();
  const recentMs = L.undeliveredRecentDays * 24 * 3_600_000;
  const [outboxes, overdue, nod, queue] = await Promise.all([
    Promise.all(s.outboxes.map(async (o) => ({ name: o.name, health: await readOr(() => o.outbox.health({ recentMs })) }))),
    readOr(() => s.overdueScheduled(L.overdueGraceMinutes * 60_000)),
    readOr(() => s.nod()),
    readOr(() => s.rebuildQueue()),
  ]);

  const checks: Record<string, Check> = {};
  for (const { name, health: h } of outboxes) {
    // Fix round 1, N5: every field named, never spread — this answer is public on SiteGround.
    // Replaced and dismissed undelivered updates never turn it red (fix round 1, I1/M1).
    checks[`outbox.${name}`] = h
      ? {
          ok: (h.oldestPendingMinutes ?? 0) <= L.outboxOldestPendingMinutes && h.recentUndelivered === 0,
          pending: h.pending,
          oldestPendingMinutes: h.oldestPendingMinutes,
          undelivered: h.undelivered,
          replaced: h.replaced,
          recentUndelivered: h.recentUndelivered,
        }
      : UNREADABLE;
  }
  checks["releases.overdue"] = overdue ? { ok: overdue.count === 0, count: overdue.count, oldestMinutes: overdue.oldestMinutes } : UNREADABLE;
  if (nod) {
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
    checks["nod.digest"] = UNREADABLE;
    checks["nod.send-loop"] = UNREADABLE;
  }
  checks["site.rebuild-queue"] = queue ? { ok: (queue.oldestMinutes ?? 0) <= L.rebuildQueueOldestMaxMinutes, pages: queue.pages, oldestMinutes: queue.oldestMinutes } : UNREADABLE;
  return checks;
}
