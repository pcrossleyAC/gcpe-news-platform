import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { deliveries, digestRuns, items, jobRecipients, sendJobs, subscribers } from "../db/schema";
import { digestJobKeyPrefix } from "../digest";
import { localDate, resolveRange } from "./range";
import { digestRunBatches, digestRunCountsSql, digestRunsPage } from "./digest-runs";

const BC = "America/Vancouver";
const ms = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
const daysAgo = (n: number) => ms(new Date(Date.now() - n * 86_400_000));

describe("daily digest runs", () => {
  let tdb: TestDatabase;
  const range = () => resolveRange({}, localDate(new Date(), BC), BC);
  const cutoff = daysAgo(2);

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [s1, s2, s3, s4] = await tdb.db
      .insert(subscribers)
      .values(["d1", "d2", "d3", "d4"].map((n) => ({ email: `${n}@example.test`, status: "active" as const, digest: true })))
      .returning({ id: subscribers.id });
    const windowStart = new Date(cutoff.getTime() - 86_400_000);
    const inWindow = new Date(cutoff.getTime() - 3_600_000);
    await tdb.db.insert(items).values([
      { key: "k1", kind: "release", postKind: "releases", title: "One", url: "https://news.example/k1", publishedAt: inWindow },
      { key: "k2", kind: "release", postKind: "stories", title: "Two", url: "https://news.example/k2", publishedAt: inWindow },
      { key: "k3", kind: "release", postKind: "advisories", title: "Advisory", url: "https://news.example/k3", publishedAt: inWindow },
      { key: "k4", kind: "release", postKind: "releases", title: "Before", url: "https://news.example/k4", publishedAt: new Date(windowStart.getTime() - 1000) },
    ]);
    await tdb.db.insert(digestRuns).values([
      { cutoff, windowStart, subscribers: 3, groups: 2 },
      { cutoff: daysAgo(60), windowStart: daysAgo(61), subscribers: 9, groups: 1 },
    ]);
    const prefix = digestJobKeyPrefix(cutoff);
    const [a, b, c] = await tdb.db
      .insert(sendJobs)
      .values([
        { jobKey: `${prefix}aaaaaaaaaaaaaaaa`, kind: "digest", priority: "digest", status: "sent" },
        { jobKey: `${prefix}bbbbbbbbbbbbbbbb`, kind: "digest", priority: "digest", status: "pending" },
        { jobKey: `${prefix}cccccccccccccccc`, kind: "digest", priority: "digest", status: "cancelled" },
      ])
      .returning({ id: sendJobs.id });
    await tdb.db.insert(jobRecipients).values([
      { jobId: a!.id, subscriberId: s1!.id },
      { jobId: a!.id, subscriberId: s2!.id },
      { jobId: b!.id, subscriberId: s3!.id },
      { jobId: c!.id, subscriberId: s4!.id },
    ]);
    const handed = { attemptedAt: cutoff, distributionBatchId: randomUUID() };
    await tdb.db.insert(deliveries).values([
      { itemKey: "k1", subscriberId: s1!.id, mode: "digest", jobId: a!.id, ...handed },
      { itemKey: "k2", subscriberId: s1!.id, mode: "digest", jobId: a!.id, ...handed },
      { itemKey: "k1", subscriberId: s2!.id, mode: "digest", jobId: a!.id, ...handed, bounceStatus: "5.1.1", hardBouncedAt: cutoff },
      { itemKey: "k2", subscriberId: s2!.id, mode: "digest", jobId: a!.id, ...handed, bounceStatus: "5.1.1", hardBouncedAt: cutoff },
      { itemKey: "k1", subscriberId: s3!.id, mode: "digest", jobId: b!.id },
    ]);
    // Noise, unrelated to any of this run's jobs: enough rows with distribution_batch_id IS NULL
    // that the planner's cost estimate actually favours the new per-job partial index over the
    // older, unscoped deliveries_distribution_batch_id_idx (bounces.ts's own index) -- without
    // this, the two tie on a handful of rows and the EXPLAIN test below can't pin which one ran.
    await tdb.db.execute(sql`
      INSERT INTO subscribers (id, email, status)
        SELECT gen_random_uuid(), 'noise-' || g || '@example.test', 'active' FROM generate_series(1, 4000) g`);
    await tdb.db.execute(sql`
      INSERT INTO deliveries (item_key, subscriber_id, mode)
        SELECT 'k1', id, 'digest' FROM subscribers WHERE email LIKE 'noise-%'`);
    await tdb.db.execute(sql`ANALYZE deliveries, send_jobs, job_recipients`);
  });
  afterAll(async () => tdb.drop());

  it("counts each run in the range by email: delivered, bounced, not sent; cancelled jobs left out", async () => {
    const page = await digestRunsPage(tdb.db, range(), 1);
    expect(page.total).toBe(1);
    expect(page.items).toEqual([
      { cutoff: cutoff.toISOString(), ranAt: expect.any(String), items: 2, subscribers: 3, delivered: 1, bounced: 1, notSent: 1 },
    ]);
  });

  it("batches the same rows for the CSV", async () => {
    const all = [];
    for await (const b of digestRunBatches(tdb.db, range())) all.push(...b);
    expect(all.map((r) => r.cutoff)).toEqual([cutoff.toISOString()]);
  });

  it("finds unsent and bounced emails through the partial indexes", async () => {
    const plan = await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const { rows } = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${digestRunCountsSql([digestJobKeyPrefix(cutoff)])}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("deliveries_job_unsent_idx");
    expect(plan).toContain("deliveries_job_bounced_idx");
    expect(plan).toContain("job_recipients_job_id_subscriber_id_pk");
  });
});
