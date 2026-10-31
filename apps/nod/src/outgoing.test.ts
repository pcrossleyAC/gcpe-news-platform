import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { deliveries, items, jobRecipients, nodSettings, operationsLog, sendJobs, subscribers } from "./db/schema";
import { cancelHeldEmail, getOutgoing, NotPausedError } from "./outgoing";

describe("outgoing news email (N3)", () => {
  let tdb: TestDatabase;
  let subs: string[];
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM send_jobs; DELETE FROM deliveries; DELETE FROM items; DELETE FROM subscribers; DELETE FROM operations_log;`);
    await tdb.db.update(nodSettings).set({ paused: true }).where(eq(nodSettings.id, 1));
    subs = (
      await tdb.db
        .insert(subscribers)
        .values([
          { email: "a@example.test", status: "active" },
          { email: "b@example.test", status: "active" },
          { email: "c@example.test", status: "disabled" },
        ])
        .returning({ id: subscribers.id })
    ).map((r) => r.id);
  });

  const item = (key: string, title: string, kind: "release" | "emergency" = "release") =>
    tdb.db.insert(items).values({ key, kind, postKind: kind === "release" ? "releases" : null, title, url: `https://news.example/${key}`, publishedAt: new Date() });
  const job = async (values: Partial<typeof sendJobs.$inferInsert> & { jobKey: string }, recipients: string[], ageDays = 0) => {
    const [row] = await tdb.db
      .insert(sendJobs)
      .values({ createdAt: sql`now() - ${`${ageDays} days`}::interval`, ...values })
      .returning({ id: sendJobs.id });
    if (recipients.length) await tdb.db.insert(jobRecipients).values(recipients.map((subscriberId) => ({ jobId: row!.id, subscriberId })));
    return row!.id;
  };

  it("lists held email by release, oldest first, counting only the active recipients who would get it; failed email separately", async () => {
    await item("r1", "Budget 2027");
    await item("r2", "Wildfire update");
    await item("e1", "Evacuation order", "emergency");
    const aih = await job({ jobKey: "as_it_happens:r1", itemKey: "r1", kind: "as_it_happens" }, subs, 12);
    const media = await job({ jobKey: "media:r1", itemKey: "r1", kind: "media", priority: "media" }, [subs[0]!], 3);
    const retrying = await job({ jobKey: "emergency:e1", itemKey: "e1", kind: "emergency", attempts: 2, lastError: "Distribution 503: unavailable" }, [subs[1]!], 1);
    // One digest run is two jobs (two groups of subscribers) over two releases.
    const cutoff = "2026-10-20T00:00:00.000Z";
    const d1 = await job({ jobKey: `digest:${cutoff}:aaaa`, kind: "digest", priority: "digest" }, [subs[0]!], 2);
    const d2 = await job({ jobKey: `digest:${cutoff}:bbbb`, kind: "digest", priority: "digest" }, [subs[1]!], 2);
    await tdb.db.insert(deliveries).values([
      { itemKey: "r1", subscriberId: subs[0]!, mode: "digest", jobId: d1 },
      { itemKey: "r2", subscriberId: subs[0]!, mode: "digest", jobId: d1 },
      { itemKey: "r2", subscriberId: subs[1]!, mode: "digest", jobId: d2 },
    ]);
    const failed = await job({ jobKey: "as_it_happens:r2", itemKey: "r2", kind: "as_it_happens", status: "failed", attempts: 1, lastError: "Distribution 400: bad request" }, subs, 1);
    await job({ jobKey: "as_it_happens:old", kind: "as_it_happens", status: "failed" }, subs, 40); // older than 30 days: not shown
    await job({ jobKey: "as_it_happens:sent", kind: "as_it_happens", status: "sent" }, subs);

    const out = await getOutgoing(tdb.db);
    expect(out.held.emails).toBe(2 + 1 + 1 + 2);
    expect(out.held.releases).toBe(3); // r1, r2 (in the digest) and e1
    expect(new Date(out.held.oldestAt!).getTime()).toBeLessThan(Date.now() - 11 * 86_400_000);
    expect(out.held.groups.map((g) => [g.kind, g.title, g.emails, g.jobIds.length])).toEqual([
      ["as_it_happens", "Budget 2027", 2, 1],
      ["media", "Budget 2027", 1, 1],
      ["digest", null, 2, 2],
      ["emergency", "Evacuation order", 1, 1],
    ]);
    expect(out.held.groups[0]!.jobIds).toEqual([aih]);
    expect(out.held.groups[1]!.jobIds).toEqual([media]);
    expect(out.held.groups[2]).toMatchObject({ digestCutoff: cutoff, releases: 2 });
    expect(out.held.groups[2]!.jobIds.sort()).toEqual([d1, d2].sort());
    expect(out.held.groups[3]).toMatchObject({ jobIds: [retrying], attempts: 2, lastError: "Distribution 503: unavailable" });
    expect(out.failed.map((g) => [g.title, g.emails, g.lastError])).toEqual([["Wildfire update", 3, "Distribution 400: bad request"]]);
    expect(out.failed[0]!.jobIds).toEqual([failed]);
  });

  it("nothing held: zero, no oldest", async () => {
    expect(await getOutgoing(tdb.db)).toEqual({ held: { emails: 0, releases: 0, oldestAt: null, groups: [] }, failed: [] });
  });

  it("cancels only the named jobs that are still held, logs it, and refuses while sending is running", async () => {
    await item("r1", "Budget 2027");
    await item("r2", "Wildfire update");
    const a = await job({ jobKey: "as_it_happens:r1", itemKey: "r1", kind: "as_it_happens" }, subs);
    const b = await job({ jobKey: "as_it_happens:r2", itemKey: "r2", kind: "as_it_happens" }, subs);
    const sent = await job({ jobKey: "media:r1", itemKey: "r1", kind: "media", status: "sent" }, subs);
    // A job the sender holds right now (claimed just before a pause) isn't touched.
    const claimed = await job({ jobKey: "media:r2", itemKey: "r2", kind: "media", lockedUntil: sql`now() + interval '5 minutes'` as unknown as Date }, subs);

    expect(await cancelHeldEmail(tdb.db, [a, sent, claimed], "Avery Admin")).toEqual({ cancelledJobs: 1, cancelledEmails: 2 });
    const rows = await tdb.db.select({ id: sendJobs.id, status: sendJobs.status }).from(sendJobs).where(inArray(sendJobs.id, [a, b, sent, claimed]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [a]: "cancelled", [b]: "pending", [sent]: "sent", [claimed]: "pending" });
    const log = await tdb.db.select().from(operationsLog);
    expect(log.map((l) => [l.actor, l.action, l.detail])).toEqual([["Avery Admin", "held-email-cancelled", "1 send job, 2 emails"]]);

    // Already cancelled: nothing more, and nothing logged.
    expect(await cancelHeldEmail(tdb.db, [a], "Avery Admin")).toEqual({ cancelledJobs: 0, cancelledEmails: 0 });
    expect(await tdb.db.select().from(operationsLog)).toHaveLength(1);

    await tdb.db.update(nodSettings).set({ paused: false }).where(eq(nodSettings.id, 1));
    await expect(cancelHeldEmail(tdb.db, [b], "Avery Admin")).rejects.toBeInstanceOf(NotPausedError);
    expect((await tdb.db.select({ status: sendJobs.status }).from(sendJobs).where(eq(sendJobs.id, b)))[0]!.status).toBe("pending");
  });
});
