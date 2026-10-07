// Smoke test for scripts/distribution-capacity.ts, at a tiny N — the real measurement
// (N=20,000) is run by hand and its output pasted into docs/parity/open-questions.md; this test
// only proves the script's own mechanics (queueing, draining at each requested concurrency, and
// the cap-holds phase) actually work, against the same in-process SMTP sink and throwaway
// Postgres database the script uses by default.
import { describe, expect, it } from "vitest";
import { runCapacityMeasurement } from "../scripts/distribution-capacity";

describe("distribution-capacity", () => {
  it("drains every recipient exactly once at each requested concurrency, with a row per concurrency in the report", async () => {
    const result = await runCapacityMeasurement({ n: 50, concurrencies: [1, 2], phaseB: false });

    expect(result.phaseA).toHaveLength(2);
    expect(result.phaseA.map((r) => r.concurrency)).toEqual([1, 2]);
    for (const row of result.phaseA) {
      // Every recipient was sent exactly once: the script itself throws if any send had to be
      // retried/failed, or if anything was still pending after the drain loop exited, so this
      // also covers "no duplicates, nothing missed".
      expect(row.delivered).toBe(50);
    }

    expect(result.markdown).toContain("| 1 |");
    expect(result.markdown).toContain("| 2 |");
    expect(result.phaseB).toBeUndefined();
  }, 30_000);

  it("holds the cap across a short, tiny-scale run", async () => {
    const result = await runCapacityMeasurement({
      n: 20,
      concurrencies: [1],
      phaseB: true,
      capPerMinute: 5,
      phaseBDurationMs: 1_500,
      phaseBWorkers: 2,
    });

    expect(result.phaseB).toBeDefined();
    expect(result.phaseB!.windows.length).toBeGreaterThan(0);
    for (const w of result.phaseB!.windows) {
      expect(w.claimed).toBeLessThanOrEqual(5);
    }
    expect(result.phaseB!.held).toBe(true);
    expect(result.markdown).toContain("Phase B: cap holds");
  }, 30_000);

  it("refuses a non-local --smtp target", async () => {
    await expect(runCapacityMeasurement({ n: 1, concurrencies: [1], smtp: "mail.example.com:25" })).rejects.toThrow(/refusing non-local/);
  });
});
