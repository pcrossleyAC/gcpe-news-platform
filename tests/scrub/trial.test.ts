import { describe, expect, it } from "vitest";
import { drainUntilIdle, replaySteps } from "../../scripts/lib/scrub/trial";

describe("drainUntilIdle", () => {
  it("stops after two quiet ticks", async () => {
    const pending = [3, 1, 0, 0, 5];
    let i = 0;
    expect(await drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: pending[i++]!, dead: 0 }) })).toBe(4);
  });
  it("fails on a dead delivery and when ticks run out", async () => {
    await expect(drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: 0, dead: 1 }) })).rejects.toThrow(/failed for good/);
    await expect(drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: 1, dead: 0 }), maxTicks: 3 })).rejects.toThrow(/still pending/);
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
