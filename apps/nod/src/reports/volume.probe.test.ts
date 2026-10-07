// Legacy-volume probe for every NoD report (Q21's Jul–Sep rates, 90 days). Opt-in: seeding 3.8 M
// delivery rows takes about half a minute. Run with REPORT_PROBE=1; prints timings (numbers only)
// and asserts the plan's budgets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { memberBatches, membersPage, subscribersByList } from "./by-list";
import { digestRunBatches, digestRunsPage } from "./digest-runs";
import { localDate, resolveRange, addDays } from "./range";
import { releaseSendBatches, releaseSendsPage, releaseSendsSql } from "./release-sends";
import { unsubscribeBatches, unsubscribesPage, unsubscribeWindow } from "./unsubscribes";

const BC = "America/Vancouver";

async function bestOf(n: number, f: () => Promise<unknown>): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    best = Math.min(best, performance.now() - t0);
  }
  return Math.round(best);
}
async function drain<T>(batches: AsyncIterable<T[]>): Promise<number> {
  let n = 0;
  for await (const b of batches) n += b.length;
  return n;
}

describe.runIf(process.env.REPORT_PROBE === "1")("report volume probe (legacy volume, 90 days)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`
        CREATE TEMP TABLE probe_subs ON COMMIT DROP AS SELECT g AS n, gen_random_uuid() AS id FROM generate_series(1, 20000) g;
        INSERT INTO subscribers (id, email, status, as_it_happens, digest, source)
          SELECT id, 'probe-' || n || '@example.test', 'active', n <= 19000, n BETWEEN 10001 AND 12750,
                 CASE WHEN n > 19800 THEN 'manual-media' ELSE 'self' END
            FROM probe_subs;
        INSERT INTO lists (list_key, category, key, name)
          SELECT 'ministries:probe-' || g, 'ministries', 'probe-' || g, 'Probe ministry ' || g FROM generate_series(1, 30) g;
        INSERT INTO subscriptions (subscriber_id, list_key)
          SELECT s.id, 'ministries:probe-' || ((s.n + k) % 30 + 1) FROM probe_subs s, generate_series(0, 2) k ON CONFLICT DO NOTHING;
        INSERT INTO subscriber_history (subscriber_id, at, actor, action)
          SELECT id, now() - ((n % 400) || ' days')::interval, 'subscriber', 'subscribed' FROM probe_subs;
        INSERT INTO subscriber_history (subscriber_id, at, actor, action)
          SELECT id, now() - ((n % 90) || ' days')::interval, 'subscriber', 'unsubscribed' FROM probe_subs WHERE n % 2 = 0;
        INSERT INTO items (key, kind, post_kind, title, url, published_at)
          SELECT 'probe-' || d || '-' || i, 'release', 'releases', 'Probe release ' || d || '-' || i, 'https://news.example/' || d || '-' || i,
                 now() - (d || ' days')::interval + (i || ' minutes')::interval
            FROM generate_series(1, 90) d, generate_series(1, 20) i;
        -- As it happens: 900 recipients a release, about 18,000 a day.
        INSERT INTO deliveries (subscriber_id, item_key, mode, attempted_at, distribution_batch_id, bounce_status)
          SELECT s.id, i.key, 'as_it_happens', i.published_at, gen_random_uuid(), CASE WHEN random() < 0.001 THEN '5.1.1' END
            FROM items i JOIN probe_subs s ON s.n BETWEEN (abs(hashtext(i.key)) % 18000) + 1 AND (abs(hashtext(i.key)) % 18000) + 900
           WHERE i.key LIKE 'probe-%';
        -- Media: 10 releases a day to 200 members, about 2,000 a day.
        INSERT INTO deliveries (subscriber_id, item_key, mode, attempted_at, distribution_batch_id, bounce_status)
          SELECT s.id, i.key, 'media', i.published_at, gen_random_uuid(), CASE WHEN random() < 0.006 THEN '5.1.1' END
            FROM items i JOIN probe_subs s ON s.n > 19800
           WHERE i.key LIKE 'probe-%' AND split_part(i.key, '-', 3)::int <= 10;
        -- Digest: 90 runs, 25 groups of 110 subscribers (2,750 a run), 8 items each.
        INSERT INTO digest_runs (cutoff, window_start, subscribers, groups)
          SELECT date_trunc('day', now()) - (d || ' days')::interval + interval '1 day', date_trunc('day', now()) - (d || ' days')::interval, 2750, 25
            FROM generate_series(1, 90) d;
        INSERT INTO send_jobs (job_key, kind, priority, status)
          SELECT 'digest:' || to_char(r.cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':' || lpad(g::text, 16, '0'), 'digest', 'digest', 'sent'
            FROM digest_runs r, generate_series(1, 25) g;
        INSERT INTO job_recipients (job_id, subscriber_id)
          SELECT j.id, s.id FROM send_jobs j
            JOIN probe_subs s ON s.n BETWEEN 10001 + (right(j.job_key, 2)::int - 1) * 110 AND 10000 + right(j.job_key, 2)::int * 110
           WHERE j.kind = 'digest';
        INSERT INTO deliveries (subscriber_id, item_key, mode, job_id, attempted_at, distribution_batch_id)
          SELECT jr.subscriber_id, 'probe-' || r.d || '-' || k, 'digest', jr.job_id, r.cutoff, gen_random_uuid()
            FROM job_recipients jr
            JOIN send_jobs j ON j.id = jr.job_id
            JOIN (SELECT cutoff, extract(day FROM date_trunc('day', now()) + interval '1 day' - cutoff)::int AS d FROM digest_runs) r
              ON left(j.job_key, 32) = 'digest:' || to_char(r.cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':'
           CROSS JOIN generate_series(1, 8) k
          ON CONFLICT DO NOTHING;
      `));
    });
    await tdb.db.execute(sql`VACUUM ANALYZE`);
  }, 300_000);
  afterAll(async () => tdb.drop());

  it("meets every budget", async () => {
    const today = localDate(new Date(), BC);
    const range90 = resolveRange({ from: addDays(today, -89), to: today }, today, BC);
    const window = await unsubscribeWindow(tdb.db, BC);
    const t = {
      byList: await bestOf(3, () => subscribersByList(tdb.db)),
      membersPage: await bestOf(3, () => membersPage(tdb.db, { list: "all", timing: "any", page: 1 })),
      membersAll: await bestOf(3, () => drain(memberBatches(tdb.db, "all", "any"))),
      unsubscribesPage: await bestOf(3, () => unsubscribesPage(tdb.db, window, 1)),
      unsubscribesAll: await bestOf(3, () => drain(unsubscribeBatches(tdb.db, window))),
      releasePage: await bestOf(3, () => releaseSendsPage(tdb.db, range90, 1)),
      releaseAll: await bestOf(3, () => drain(releaseSendBatches(tdb.db, range90))),
      digestPage: await bestOf(3, () => digestRunsPage(tdb.db, range90, 1)),
      digestAll: await bestOf(3, () => drain(digestRunBatches(tdb.db, range90))),
    };
    console.log("[probe] NoD report timings (ms, best of 3):", JSON.stringify(t));
    expect(await drain(releaseSendBatches(tdb.db, range90))).toBeGreaterThan(1700);
    // At this volume the planner itself, not a test's enable_seqscan, picks the partial index.
    const { rows: plan } = await tdb.db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${releaseSendsSql(range90, 500, 0)}`);
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("Index Only Scan using deliveries_item_mode_idx");
    // The digest timings mean something only if each run's jobs were actually found.
    expect((await digestRunsPage(tdb.db, range90, 1)).items[0]!.subscribers).toBe(2750);
    expect(t.byList).toBeLessThan(300);
    expect(t.membersPage).toBeLessThan(300);
    expect(t.membersAll).toBeLessThan(1000);
    expect(t.unsubscribesPage).toBeLessThan(300);
    expect(t.unsubscribesAll).toBeLessThan(1000);
    expect(t.releasePage).toBeLessThan(300);
    expect(t.releaseAll).toBeLessThan(2000);
    expect(t.digestPage).toBeLessThan(300);
    expect(t.digestAll).toBeLessThan(1000);
  }, 300_000);
});
