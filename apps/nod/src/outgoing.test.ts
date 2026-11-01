import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { deliveries, items, jobRecipients, nodSettings, operationsLog, sendJobs, subscribers } from "./db/schema";
import { cancelAllHeldEmail, cancelHeldEmail, getOutgoing, HeldChangedError, NotPausedError } from "./outgoing";

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
    expect(await getOutgoing(tdb.db)).toEqual({ held: { emails: 0, releases: 0, oldestAt: null, jobs: 0, heldKey: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", newestAt: null, groups: [] }, failed: [] });
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
    // Review I1: the log says which releases, not only totals.
    expect(log.map((l) => [l.actor, l.action, l.detail])).toEqual([["Avery Admin", "held-email-cancelled", '1 send job, 2 emails: As it happens r1 "Budget 2027" (2 emails)']]);

    // Already cancelled: nothing more, and nothing logged.
    expect(await cancelHeldEmail(tdb.db, [a], "Avery Admin")).toEqual({ cancelledJobs: 0, cancelledEmails: 0 });
    expect(await tdb.db.select().from(operationsLog)).toHaveLength(1);

    await tdb.db.update(nodSettings).set({ paused: false }).where(eq(nodSettings.id, 1));
    await expect(cancelHeldEmail(tdb.db, [b], "Avery Admin")).rejects.toBeInstanceOf(NotPausedError);
    expect((await tdb.db.select({ status: sendJobs.status }).from(sendJobs).where(eq(sendJobs.id, b)))[0]!.status).toBe("pending");
  });

  it("the cancel log names each release and digest day, and stays under its cap with 'and N more'", async () => {
    await item("r1", "Budget 2027");
    const a = await job({ jobKey: "as_it_happens:r1", itemKey: "r1", kind: "as_it_happens" }, [subs[0]!]);
    const cutoff = "2026-10-20T00:00:00.000Z";
    const d1 = await job({ jobKey: `digest:${cutoff}:aaaa`, kind: "digest", priority: "digest" }, [subs[0]!]);
    const d2 = await job({ jobKey: `digest:${cutoff}:bbbb`, kind: "digest", priority: "digest" }, [subs[1]!]);
    await tdb.db.insert(deliveries).values([
      { itemKey: "r1", subscriberId: subs[0]!, mode: "digest", jobId: d1 },
      { itemKey: "r1", subscriberId: subs[1]!, mode: "digest", jobId: d2 },
    ]);
    await cancelHeldEmail(tdb.db, [a, d1, d2], "Avery Admin");
    const [first] = await tdb.db.select().from(operationsLog);
    expect(first!.detail).toBe('3 send jobs, 3 emails: As it happens r1 "Budget 2027" (1 email); Daily digest 2026-10-20 (1 release, 2 emails)');

    await tdb.db.delete(operationsLog);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      await item(`long${i}`, `A very long release title number ${i} `.repeat(4));
      ids.push(await job({ jobKey: `as_it_happens:long${i}`, itemKey: `long${i}`, kind: "as_it_happens" }, [subs[0]!]));
    }
    await cancelHeldEmail(tdb.db, ids, "Avery Admin");
    const [log] = await tdb.db.select().from(operationsLog);
    expect(log!.detail.length).toBeLessThanOrEqual(2000);
    expect(log!.detail).toMatch(/^60 send jobs, 60 emails: As it happens long0 /);
    expect(log!.detail).toMatch(/; and \d+ more$/);
  });

  it("review M1: recipients a partly sent job already handed to Distribution aren't counted as held or cancelled", async () => {
    await item("r1", "Budget 2027");
    const a = await job({ jobKey: "as_it_happens:r1", itemKey: "r1", kind: "as_it_happens", attempts: 1 }, [subs[0]!, subs[1]!]);
    await tdb.db.insert(deliveries).values([
      { itemKey: "r1", subscriberId: subs[0]!, mode: "as_it_happens", jobId: a, attemptedAt: new Date() },
      { itemKey: "r1", subscriberId: subs[1]!, mode: "as_it_happens", jobId: a },
    ]);
    expect((await getOutgoing(tdb.db)).held).toMatchObject({ emails: 1 });
    expect(await cancelHeldEmail(tdb.db, [a], "Avery Admin")).toEqual({ cancelledJobs: 1, cancelledEmails: 1 });
  });

  // Cancel all (suite review NC): the request carries a marker, not 2,500+ ids, so the shared 100 kb
  // JSON limit can't stop it. These make many jobs in one statement.
  const manyJobs = async (n: number, prefix = "bulk") => {
    await tdb.db.execute(sql`
      INSERT INTO send_jobs (job_key, kind, created_at)
      SELECT ${prefix} || ':' || g, 'media', now() - (g || ' seconds')::interval FROM generate_series(1, ${n}) g`);
    await tdb.db.execute(sql`
      INSERT INTO job_recipients (job_id, subscriber_id)
      SELECT j.id, ${subs[0]!}::uuid FROM send_jobs j WHERE j.job_key LIKE ${prefix + ":%"}`);
  };
  const snapshot = async () => {
    const { held } = await getOutgoing(tdb.db);
    return { heldKey: held.heldKey, newestAt: held.newestAt! };
  };
  const statuses = async () =>
    Object.fromEntries((await tdb.db.execute<{ status: string; n: number }>(sql`SELECT status, count(*)::int AS n FROM send_jobs GROUP BY status`)).rows.map((r) => [r.status, r.n]));

  it("NC: Cancel all cancels 3,000 held jobs from a marker, in one go, and logs it", async () => {
    await manyJobs(3000);
    const snap = await snapshot();
    expect((await getOutgoing(tdb.db)).held.jobs).toBe(3000);
    expect(await cancelAllHeldEmail(tdb.db, snap, "Avery Admin")).toEqual({ cancelledJobs: 3000, cancelledEmails: 3000 });
    expect(await statuses()).toEqual({ cancelled: 3000 });
    const log = await tdb.db.select().from(operationsLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "Avery Admin", action: "held-email-cancelled" });
    expect(log[0]!.detail).toMatch(/^3,000 send jobs, 3,000 emails: Media list /);
    expect(log[0]!.detail.length).toBeLessThanOrEqual(2000);
  });

  it("NC: Cancel all refuses, changing nothing, when a job the screen showed has gone meanwhile", async () => {
    await manyJobs(5);
    const snap = await snapshot();
    await tdb.db.execute(sql`UPDATE send_jobs SET status = 'sent' WHERE job_key = 'bulk:2'`);
    await expect(cancelAllHeldEmail(tdb.db, snap, "Avery Admin")).rejects.toBeInstanceOf(HeldChangedError);
    expect(await statuses()).toEqual({ pending: 4, sent: 1 });
    expect(await tdb.db.select().from(operationsLog)).toHaveLength(0);
  });

  it("NC: Cancel all leaves alone a job that was made after the screen loaded", async () => {
    await manyJobs(5);
    const snap = await snapshot();
    await tdb.db.execute(sql`INSERT INTO send_jobs (job_key, kind, created_at) VALUES ('later:1', 'media', now() + interval '1 minute')`);
    expect(await cancelAllHeldEmail(tdb.db, snap, "Avery Admin")).toMatchObject({ cancelledJobs: 5 });
    expect(await statuses()).toEqual({ cancelled: 5, pending: 1 });
  });

  it("NC review I1: an equal add and remove doesn't fool Cancel all (same count, older timestamp), and nothing is cancelled", async () => {
    await manyJobs(3);
    const snap = await snapshot();
    // A digest-style job that committed late but carries an earlier start time, and one shown job gone.
    await tdb.db.execute(sql`INSERT INTO send_jobs (job_key, kind, created_at) VALUES ('late:1', 'media', now() - interval '1 hour')`);
    await tdb.db.execute(sql`UPDATE send_jobs SET status = 'cancelled' WHERE job_key = 'bulk:1'`);
    await expect(cancelAllHeldEmail(tdb.db, snap, "Avery Admin")).rejects.toBeInstanceOf(HeldChangedError);
    expect(await statuses()).toEqual({ cancelled: 1, pending: 3 });
    expect(await tdb.db.select().from(operationsLog)).toHaveLength(0);
  });

  it("NC review M2: Cancel all locks the set it checked, so a concurrent cancel waits and can't make it 'partly'", async () => {
    await manyJobs(3);
    const snap = await snapshot();
    const { rows: [one] } = await tdb.db.execute<{ id: string }>(sql`SELECT id FROM send_jobs WHERE job_key = 'bulk:1'`);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const other = tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM send_jobs WHERE id = ${one!.id}::uuid FOR UPDATE`);
      locked();
      await held;
      await tx.execute(sql`UPDATE send_jobs SET status = 'cancelled' WHERE id = ${one!.id}::uuid`);
    });
    await isLocked;
    const all = cancelAllHeldEmail(tdb.db, snap, "Avery Admin");
    const settled = await Promise.race([all.then(() => "done", () => "done"), new Promise((r) => setTimeout(() => r("waiting"), 300))]);
    expect(settled).toBe("waiting"); // the cancel-all SELECT is blocked on the row lock, not racing past it
    release();
    await other;
    // The other admin's cancel committed first; the set differs, so it is refused rather than reported as "partly".
    await expect(all).rejects.toBeInstanceOf(HeldChangedError);
    expect(await statuses()).toEqual({ cancelled: 1, pending: 2 });
  });

  it("NC: Cancel all refuses while sending is running", async () => {
    await manyJobs(2);
    const snap = await snapshot();
    await tdb.db.update(nodSettings).set({ paused: false }).where(eq(nodSettings.id, 1));
    await expect(cancelAllHeldEmail(tdb.db, snap, "Avery Admin")).rejects.toBeInstanceOf(NotPausedError);
    expect(await statuses()).toEqual({ pending: 2 });
  });
});
