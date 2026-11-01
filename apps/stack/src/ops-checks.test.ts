import { describe, expect, it } from "vitest";
import type { OutboxAdmin, OutboxHealth } from "@gcpe/events";
import type { NodHealth } from "../../nod/src/health";
import { HEALTH_LIMITS, runOpsChecks, type OpsSources } from "./ops-checks";

const quietOutbox = (h: Partial<OutboxHealth> = {}): Pick<OutboxAdmin, "health"> => ({
  health: async () => ({ pending: 0, oldestPendingMinutes: null, undelivered: 0, recentUndelivered: 0, ...h }),
});

const quietNod: NodHealth = {
  digestMinutesAgo: 60,
  emergencyFeed: { on: true, minutesSinceLastCheck: 2, lastCheckOk: true },
  mediaSync: { on: true, minutesSinceLastSuccess: 300, lastRunFailed: false },
  sendLoopMinutesAgo: 0,
};

function sources(over: Partial<OpsSources> = {}): OpsSources {
  return {
    outboxes: [
      { name: "nrms", outbox: quietOutbox() },
      { name: "core", outbox: quietOutbox() },
    ],
    overdueScheduled: async () => ({ count: 0, oldestMinutes: null }),
    nod: async () => quietNod,
    rebuildQueue: async () => ({ pages: 0, oldestMinutes: null }),
    uptimeMinutes: () => 5,
    ...over,
  };
}

// Suite review O2.1 (owner 2026-10-31): /stack/health's checks block.
describe("runOpsChecks", () => {
  it("is all green when nothing is waiting, late or failing", async () => {
    const checks = await runOpsChecks(sources());
    expect(Object.keys(checks)).toEqual(["outbox.nrms", "outbox.core", "releases.overdue", "nod.digest", "nod.emergency-feed", "nod.media-sync", "nod.send-loop", "site.rebuild-queue"]);
    expect(Object.values(checks).every((c) => c.ok)).toBe(true);
    expect(checks["outbox.nrms"]).toEqual({ ok: true, pending: 0, oldestPendingMinutes: null, undelivered: 0, recentUndelivered: 0 });
  });

  it("turns an outbox red for a long wait or a recent undelivered update, not for an old one", async () => {
    const checks = await runOpsChecks(
      sources({
        outboxes: [
          { name: "nrms", outbox: quietOutbox({ pending: 900, oldestPendingMinutes: HEALTH_LIMITS.outboxOldestPendingMinutes + 1 }) },
          { name: "core", outbox: quietOutbox({ undelivered: 1, recentUndelivered: 1 }) },
          { name: "news-api", outbox: quietOutbox({ undelivered: 3, recentUndelivered: 0 }) },
          { name: "calendar", outbox: quietOutbox({ pending: 5, oldestPendingMinutes: HEALTH_LIMITS.outboxOldestPendingMinutes }) },
        ],
      }),
    );
    expect(checks["outbox.nrms"]!.ok).toBe(false);
    expect(checks["outbox.nrms"]!.pending).toBe(900);
    expect(checks["outbox.core"]!.ok).toBe(false);
    expect(checks["outbox.news-api"]).toMatchObject({ ok: true, undelivered: 3 });
    expect(checks["outbox.calendar"]!.ok).toBe(true);
  });

  it("turns releases red when one is overdue", async () => {
    const checks = await runOpsChecks(sources({ overdueScheduled: async () => ({ count: 2, oldestMinutes: 40 }) }));
    expect(checks["releases.overdue"]).toEqual({ ok: false, count: 2, oldestMinutes: 40 });
  });

  it("asks for the overdue grace from its named limit", async () => {
    let asked = 0;
    await runOpsChecks(sources({ overdueScheduled: async (graceMs) => ((asked = graceMs), { count: 0, oldestMinutes: null }) }));
    expect(asked).toBe(HEALTH_LIMITS.overdueGraceMinutes * 60_000);
  });

  it("turns NoD's checks red when each is too late or failed", async () => {
    const late: NodHealth = {
      digestMinutesAgo: HEALTH_LIMITS.digestMaxMinutes + 1,
      emergencyFeed: { on: true, minutesSinceLastCheck: 3, lastCheckOk: false },
      mediaSync: { on: true, minutesSinceLastSuccess: 10, lastRunFailed: true },
      sendLoopMinutesAgo: HEALTH_LIMITS.sendLoopMaxMinutes + 1,
    };
    const checks = await runOpsChecks(sources({ nod: async () => late }));
    expect(checks["nod.digest"]).toEqual({ ok: false, minutesSinceLastRun: HEALTH_LIMITS.digestMaxMinutes + 1 });
    expect(checks["nod.emergency-feed"]).toEqual({ ok: false, minutesSinceLastCheck: 3, lastCheckOk: false });
    expect(checks["nod.media-sync"]).toEqual({ ok: false, minutesSinceLastSuccess: 10, lastRunFailed: true });
    expect(checks["nod.send-loop"]).toEqual({ ok: false, minutesSinceLastRun: HEALTH_LIMITS.sendLoopMaxMinutes + 1 });
  });

  it("an emergency feed that stopped being checked is red even if its last check was fine", async () => {
    const checks = await runOpsChecks(sources({ nod: async () => ({ ...quietNod, emergencyFeed: { on: true, minutesSinceLastCheck: HEALTH_LIMITS.emergencyFeedMaxMinutes + 1, lastCheckOk: true } }) }));
    expect(checks["nod.emergency-feed"]!.ok).toBe(false);
  });

  it("never run is fine just after a start and red once the process has been up past the limit", async () => {
    const never: NodHealth = {
      digestMinutesAgo: null,
      emergencyFeed: { on: true, minutesSinceLastCheck: null, lastCheckOk: null },
      mediaSync: { on: true, minutesSinceLastSuccess: null, lastRunFailed: false },
      sendLoopMinutesAgo: null,
    };
    const fresh = await runOpsChecks(sources({ nod: async () => never, uptimeMinutes: () => 1 }));
    expect(["nod.digest", "nod.emergency-feed", "nod.media-sync", "nod.send-loop"].map((n) => fresh[n]!.ok)).toEqual([true, true, true, true]);
    const old = await runOpsChecks(sources({ nod: async () => never, uptimeMinutes: () => HEALTH_LIMITS.digestMaxMinutes + 1 }));
    expect(["nod.digest", "nod.emergency-feed", "nod.media-sync", "nod.send-loop"].map((n) => old[n]!.ok)).toEqual([false, false, false, false]);
  });

  it("leaves out the emergency feed and the Media Hub sync when they're off", async () => {
    const checks = await runOpsChecks(
      sources({ nod: async () => ({ ...quietNod, emergencyFeed: { on: false, minutesSinceLastCheck: null, lastCheckOk: null }, mediaSync: { on: false, minutesSinceLastSuccess: null, lastRunFailed: false } }) }),
    );
    expect(checks).not.toHaveProperty("nod.emergency-feed");
    expect(checks).not.toHaveProperty("nod.media-sync");
  });

  it("turns the rebuild queue red only when its oldest page has waited too long", async () => {
    const long = await runOpsChecks(sources({ rebuildQueue: async () => ({ pages: 20_000, oldestMinutes: 30 }) }));
    expect(long["site.rebuild-queue"]).toEqual({ ok: true, pages: 20_000, oldestMinutes: 30 });
    const stuck = await runOpsChecks(sources({ rebuildQueue: async () => ({ pages: 3, oldestMinutes: HEALTH_LIMITS.rebuildQueueOldestMaxMinutes + 1 }) }));
    expect(stuck["site.rebuild-queue"]!.ok).toBe(false);
  });

  it("a check that can't be read is red and says so, and the others still run", async () => {
    const checks = await runOpsChecks(
      sources({
        outboxes: [{ name: "nrms", outbox: { health: async () => Promise.reject(new Error("connection refused, password=hunter2")) } }],
        nod: async () => Promise.reject(new Error("down")),
      }),
    );
    expect(checks["outbox.nrms"]).toEqual({ ok: false, error: "couldn't check" });
    expect(checks["nod.digest"]).toEqual({ ok: false, error: "couldn't check" });
    expect(checks["releases.overdue"]!.ok).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("hunter2");
  });
});
