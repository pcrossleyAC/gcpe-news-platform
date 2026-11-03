import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainUntilIdle, replaySteps } from "../../scripts/lib/scrub/trial";

describe("drainUntilIdle", () => {
  it("stops after two quiet ticks", async () => {
    const pending = [3, 1, 0, 0, 5];
    let i = 0;
    expect(await drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: pending[i++]!, dead: 0 }) })).toBe(4);
  });

  it("fails on a dead delivery", async () => {
    await expect(drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: 0, dead: 1 }) })).rejects.toThrow(/failed for good/);
  });

  it("completes a long but steadily falling queue past the old 300-tick cap", async () => {
    // Legacy-scale replays (tens of thousands of activities/release statuses) take far more than
    // 300 ticks to drain; this only needs the pending count to keep falling, one at a time, well
    // past that old cap.
    let remaining = 400;
    const pending = async () => {
      const p = Math.max(0, remaining);
      remaining--;
      return { pending: p, dead: 0 };
    };
    const ticks = await drainUntilIdle({ tick: async () => {}, pending });
    expect(ticks).toBeGreaterThan(300);
  });

  it("fails with the stall message when the pending count stops improving", async () => {
    await expect(
      drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: 50, dead: 0 }), staleTicks: 5 }),
    ).rejects.toThrow(/event delivery stalled with 50 still pending/);
  });

  it("completes a rise-then-fall queue without a false stall", async () => {
    // Delivered events can fan out into new ones: the count falls, then genuinely rises well
    // above its lowest-ever value, then resumes falling. That single rise must not be judged
    // against "the lowest ever seen" (which would count every one of the ~290 ticks it takes to
    // fall back below 10 as stale, and falsely stall) — only against the immediately previous
    // tick, so the one rising tick counts as stale once and the very next falling tick clears it.
    const sequence: number[] = [];
    for (let p = 100; p >= 10; p--) sequence.push(p); // falls: 100..10
    sequence.push(300); // one-tick burst, far above the lowest-ever value (10)
    for (let p = 299; p >= 0; p--) sequence.push(p); // falls again: 299..0
    sequence.push(0); // second quiet tick, so the drain completes
    let i = 0;
    const ticks = await drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: sequence[i++]!, dead: 0 }) });
    expect(ticks).toBe(sequence.length);
  });

  describe("the wall-clock cap", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails once the cap is passed, even while the count keeps (slowly) falling", async () => {
      let i = 0;
      await expect(
        drainUntilIdle({
          tick: async () => {
            vi.advanceTimersByTime(60_000);
          },
          pending: async () => ({ pending: 1000 - i++, dead: 0 }),
          maxWallMs: 5 * 60_000,
        }),
      ).rejects.toThrow(/event delivery timed out/);
    });
  });

  it("reports a progress line every 100 ticks, with just the tick number and the pending count", async () => {
    let remaining = 249;
    const pending = async () => {
      const p = Math.max(0, remaining);
      remaining--;
      return { pending: p, dead: 0 };
    };
    const lines: string[] = [];
    await drainUntilIdle({ tick: async () => {}, pending, log: (line) => lines.push(line) });
    expect(lines).toEqual(["tick 100: 150 pending", "tick 200: 50 pending"]);
  });
});

describe("replaySteps", () => {
  it("replays activities to NRMS, links to the Calendar, then fills search text", () => {
    const steps = replaySteps({ core: "c", nrms: "n", newsApi: "a", site: "s", calendar: "k", nod: "d", distribution: "t" });
    expect(steps.map((s) => s.npmArgs[1])).toEqual(["calendar:replay-to-nrms", "nrms:replay-activity-links", "news-api:search-backfill"]);
    expect(steps[0]!.env.DATABASE_URL).toBe("k");
    expect(JSON.parse(steps[1]!.env.EVENT_SUBSCRIBERS!)[0].types).toEqual(["release.status_changed"]);
  });
});
