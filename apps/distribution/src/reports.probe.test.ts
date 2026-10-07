// Legacy-volume probe for the daily report: about 22,800 messages a day for 90 days (Q21). Opt-in
// with REPORT_PROBE=1; prints timings (numbers only) and asserts the plan's budgets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../test/helpers";
import { dailyReport } from "./reports";

async function bestOf(n: number, f: () => Promise<unknown>): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    best = Math.min(best, performance.now() - t0);
  }
  return Math.round(best);
}
const days = (n: number) => Array.from({ length: n + 1 }, (_, i) => new Date(Date.now() - (n - i) * 86_400_000));

describe.runIf(process.env.REPORT_PROBE === "1")("Distribution report volume probe", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
    await tdb.db.execute(sql.raw(`
      INSERT INTO batches (app_id, subject, html, created_at)
        SELECT CASE WHEN b % 50 = 0 THEN 'nrms' ELSE 'nod' END, 's', '<p>h</p>', now() - ((b / 23) || ' days')::interval
          FROM generate_series(1, 2070) b;
      INSERT INTO messages (batch_id, email, priority, status, sent_at, bounced_at, bounce_hard)
        SELECT b.id, 'user' || g || '@example.test', 30,
               CASE WHEN g % 5000 = 0 THEN 'failed' ELSE 'sent' END,
               CASE WHEN g % 5000 = 0 THEN NULL ELSE b.created_at + (g || ' milliseconds')::interval END,
               CASE WHEN g % 900 = 0 THEN b.created_at END,
               CASE WHEN g % 900 = 0 THEN (g % 1800 = 0) END
          FROM batches b, generate_series(1, 1000) g;
    `));
    await tdb.db.execute(sql`VACUUM ANALYZE messages`);
  }, 300_000);
  afterAll(async () => tdb.drop());

  it("meets the budgets", async () => {
    const t = { days92: await bestOf(3, () => dailyReport(tdb.db, days(92))), days31: await bestOf(3, () => dailyReport(tdb.db, days(31))) };
    console.log("[probe] Distribution report timings (ms, best of 3):", JSON.stringify(t));
    expect(t.days92).toBeLessThan(1000);
    expect(t.days31).toBeLessThan(500);
  }, 300_000);
});
