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
      // Don't just trust sendDue's own "sent" count — independently confirm the in-process
      // sink actually received exactly N messages, to exactly N distinct recipients, for each
      // concurrency.
      expect(row.sinkReceived).toBe(50);
      expect(row.duplicateRecipients).toBe(0);
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

  it("refuses a non-local database admin target, before doing any database work", async () => {
    const original = process.env.TEST_DATABASE_ADMIN_URL;
    process.env.TEST_DATABASE_ADMIN_URL = "postgres://db.example.com:5432/postgres";
    try {
      await expect(runCapacityMeasurement({ n: 1, concurrencies: [1] })).rejects.toThrow(/refusing a non-local database admin target/);
    } finally {
      if (original === undefined) delete process.env.TEST_DATABASE_ADMIN_URL;
      else process.env.TEST_DATABASE_ADMIN_URL = original;
    }
  });

  it("refuses a local-looking hostname that a \"?host=\" query param overrides to a remote target", async () => {
    // pg-connection-string takes a "?host=" query param over the URL's own hostname whenever
    // one is present -- the hostname here is "localhost", but pg would actually connect to
    // db.remote.example, so the guard must follow the query param, not the hostname.
    const original = process.env.TEST_DATABASE_ADMIN_URL;
    process.env.TEST_DATABASE_ADMIN_URL = "postgres://localhost:5432/postgres?host=db.remote.example";
    try {
      await expect(runCapacityMeasurement({ n: 1, concurrencies: [1] })).rejects.toThrow(/refusing a non-local database admin target/);
    } finally {
      if (original === undefined) delete process.env.TEST_DATABASE_ADMIN_URL;
      else process.env.TEST_DATABASE_ADMIN_URL = original;
    }
  });

  it("refuses a remote PGHOST when the admin URL itself has no host", async () => {
    // An empty hostname and no "?host=" param falls back to PGHOST (then "localhost"), the same
    // precedence pg's own connection-parameters.js applies -- a remote PGHOST must not connect
    // past this guard unseen just because the URL itself names no host.
    const originalUrl = process.env.TEST_DATABASE_ADMIN_URL;
    const originalPgHost = process.env.PGHOST;
    process.env.TEST_DATABASE_ADMIN_URL = "postgres:///postgres";
    process.env.PGHOST = "db.remote.example";
    try {
      await expect(runCapacityMeasurement({ n: 1, concurrencies: [1] })).rejects.toThrow(/refusing a non-local database admin target/);
    } finally {
      if (originalUrl === undefined) delete process.env.TEST_DATABASE_ADMIN_URL;
      else process.env.TEST_DATABASE_ADMIN_URL = originalUrl;
      if (originalPgHost === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = originalPgHost;
    }
  });
});
