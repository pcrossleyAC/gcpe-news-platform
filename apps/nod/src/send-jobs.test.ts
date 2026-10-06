import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createTestDatabase, dbClock } from "@gcpe/db-kit";
import { DistributionError, distributionClient, type DistributionClient, type MessageRequest } from "./distribution-client";
import { jobRecipients, sendJobs, subscribers } from "./db/schema";
import { MAX_CHUNK_BYTES, MAX_RECIPIENTS_PER_CHUNK, ensureChunksAssigned, sendDueJobs } from "./send-jobs";

const nodMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
const MANAGE_URL = "https://news.example/subscribe/manage";

async function insertSubscriber(db: TestDatabase["db"], email: string, opts: { active?: boolean; id?: string } = {}): Promise<{ id: string }> {
  const active = opts.active !== false;
  const [row] = await db
    .insert(subscribers)
    .values({
      ...(opts.id ? { id: opts.id } : {}),
      email,
      verifiedAt: active ? new Date() : null,
      status: active ? "active" : "pending",
    })
    .returning({ id: subscribers.id });
  return row!;
}

/** A fixed, ordered low UUID — lets a test control exactly which subscriber lands in which
 * chunk (chunk assignment orders by subscriber id, and `defaultRandom()` ids sort
 * unpredictably relative to insertion order). */
const lowId = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function insertJob(db: TestDatabase["db"], itemKey: string, overrides: Partial<typeof sendJobs.$inferInsert> = {}) {
  const [row] = await db
    .insert(sendJobs)
    .values({
      jobKey: `as_it_happens:${itemKey}`,
      itemKey,
      subject: "Clinics open",
      html: "<p>hi</p>",
      text: "hi",
      ...overrides,
    })
    .returning();
  return row!;
}

function stubDistribution(): DistributionClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn> };
}

/**
 * A fake Distribution that behaves like the real one with respect to idempotency: the same
 * `idempotencyKey` always gets back the batchId it got the first time, without re-recording
 * whatever recipients happened to be sent alongside the repeat (exactly as Distribution itself
 * would dedupe — see apps/distribution/src/messages.ts's createBatch). `failKeyOnce` makes the
 * *first* call for that specific key throw a retryable error, then behave normally after.
 */
function dedupingDistribution(opts: { failKeyOnce?: string } = {}): DistributionClient & { calls: MessageRequest[] } {
  const accepted = new Map<string, string>();
  let seq = 0;
  let failedOnce = false;
  const calls: MessageRequest[] = [];
  return {
    calls,
    async send(req: MessageRequest) {
      calls.push(req);
      const key = req.idempotencyKey!;
      if (opts.failKeyOnce === key && !failedOnce) {
        failedOnce = true;
        throw new DistributionError("HTTP 503", true);
      }
      const existing = accepted.get(key);
      if (existing) return { batchId: existing };
      const batchId = `batch-${++seq}`;
      accepted.set(key, batchId);
      return { batchId };
    },
  };
}

describe("sendDueJobs", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder: nodMigrations });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE send_jobs, job_recipients, subscribers CASCADE");
  });

  it("sends one request with every active recipient and list-unsubscribe headers", async () => {
    const alex = await insertSubscriber(tdb.db, "alex@example.com");
    const sam = await insertSubscriber(tdb.db, "sam@example.com");
    const job = await insertJob(tdb.db, "release-1");
    await tdb.db.insert(jobRecipients).values([
      { jobId: job.id, subscriberId: alex.id },
      { jobId: job.id, subscriberId: sam.id },
    ]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "batch-1" });

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.idempotencyKey).toBe(`${job.id}:0`);
    expect(req.headers).toEqual({ "List-Unsubscribe": "<{{manageUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(req.recipients.map((r) => r.email).sort()).toEqual(["alex@example.com", "sam@example.com"]);

    const updated = (await tdb.db.select().from(sendJobs))[0]!;
    expect(updated.status).toBe("sent");
    expect(updated.batchIds).toEqual({ "0": "batch-1" });
    expect(updated.lockedUntil).toBeNull();
  });

  it("only sends to active subscribers", async () => {
    const active = await insertSubscriber(tdb.db, "active@example.com");
    const pending = await insertSubscriber(tdb.db, "pending@example.com", { active: false });
    const job = await insertJob(tdb.db, "release-2");
    // A pending subscriber was never added to job_recipients by the Task 9 handler in the
    // first place (createAsItHappensHandler filters on status = 'active'), but even if a row
    // existed, the recipient query itself re-checks status — belt and suspenders.
    await tdb.db.insert(jobRecipients).values([
      { jobId: job.id, subscriberId: active.id },
      { jobId: job.id, subscriberId: pending.id },
    ]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "batch-x" });
    await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });

    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.recipients.map((r) => r.email)).toEqual(["active@example.com"]);
  });

  it("retries a retryable failure with backoff, then succeeds using the same idempotency key", async () => {
    const sub = await insertSubscriber(tdb.db, "retry@example.com");
    const job = await insertJob(tdb.db, "release-3");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValueOnce(new DistributionError("HTTP 503", true));

    const before = Date.now();
    const result1 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0 });

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(afterFirst.lockedUntil).toBeNull();

    distribution.send.mockResolvedValueOnce({ batchId: "batch-2" });
    // The backoff was computed from the database's now() (µs); a JS Date of it is truncated to
    // the millisecond, so the test clock is set 1ms past it to be on or after the real value.
    const result2 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, now: () => new Date(afterFirst.nextAttemptAt.getTime() + 1) });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(distribution.send).toHaveBeenCalledTimes(2);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);

    const afterSecond = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterSecond.status).toBe("sent");
    expect(afterSecond.batchIds).toEqual({ "0": "batch-2" });
  });

  it("fails immediately on a non-retryable error", async () => {
    const sub = await insertSubscriber(tdb.db, "bad@example.com");
    const job = await insertJob(tdb.db, "release-4");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new DistributionError("HTTP 400: invalid subject", false));

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/HTTP 400/);
  });

  // I5: a job going failed/retrying was otherwise silent — nothing else notices a release that
  // stopped mailing.
  it("logs once (console.error) when a job goes failed", async () => {
    const sub = await insertSubscriber(tdb.db, "logfail@example.com");
    const job = await insertJob(tdb.db, "release-logfail");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new DistributionError("HTTP 400: invalid subject", false));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
      expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`[nod] job ${job.id} item release-logfail failed: HTTP 400`));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs a warning (console.warn) when a job retries", async () => {
    const sub = await insertSubscriber(tdb.db, "logretry@example.com");
    const job = await insertJob(tdb.db, "release-logretry");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new DistributionError("HTTP 503", true));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`[nod] job ${job.id} item release-logretry retrying (attempt 1): HTTP 503`));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Fix 8 (P2-R16): a chunk accepted before a later chunk fails the job must still be
  // recorded — otherwise re-deriving "what did Distribution already accept" after a terminal
  // failure requires trusting Distribution's own dedup forever, with no local record at all.
  it("persists already-accepted chunk batch ids even when a later chunk fails the job outright", async () => {
    const subs = await Promise.all([0, 1, 2].map((n) => insertSubscriber(tdb.db, `p${n}@example.com`, { id: lowId(n) })));
    const job = await insertJob(tdb.db, "release-persist");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    const distribution = stubDistribution();
    distribution.send.mockResolvedValueOnce({ batchId: "ok-0" }).mockRejectedValueOnce(new DistributionError("HTTP 400: bad subject", false));

    // chunkSize 1 over 3 recipients → 3 chunks; chunk 0 succeeds, chunk 1 fails permanently,
    // chunk 2 is never attempted.
    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, chunkSize: 1 });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("failed");
    expect(row.batchIds).toEqual({ "0": "ok-0" });
  });

  it("fails a retryable error once the job is older than maxAgeMs", async () => {
    const sub = await insertSubscriber(tdb.db, "old@example.com");
    const job = await insertJob(tdb.db, "release-5");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new DistributionError("HTTP 503", true));

    // The job's real created_at is "now"; running as if 25h have passed exceeds the default
    // 24h maxAgeMs even though the error itself is retryable.
    const future = new Date(Date.now() + 25 * 3_600_000);
    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, now: () => future });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("failed");
  });

  // Fix 2 (P2-R16): a failure fetching the token itself (the endpoint being down, timing out,
  // ...) must not permanently fail the job — distribution.send never even reached Distribution.
  it("treats a token-fetch failure as retryable, not a permanent failure", async () => {
    const sub = await insertSubscriber(tdb.db, "tok@example.com");
    const job = await insertJob(tdb.db, "release-token-fail");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = distributionClient({
      baseUrl: "http://127.0.0.1:1",
      getToken: async () => {
        throw new Error("token endpoint responded HTTP 503");
      },
    });

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  // Fix 2 (P2-R16, send-jobs.ts side): an error thrown by `distribution.send` that isn't
  // already a DistributionError (e.g. a custom DistributionClient implementation that throws
  // a plain Error) must still be treated as retryable, not fail the job outright.
  it("treats an unexpected (non-DistributionError) send failure as retryable", async () => {
    const sub = await insertSubscriber(tdb.db, "unexpected@example.com");
    const job = await insertJob(tdb.db, "release-unexpected");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new Error("boom"));

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  // Fix 3 (P2-R16): a 401/403 from Distribution is a credentials problem that's usually
  // transient (propagation delay, clock skew, a brief outage at the issuer) — it must not
  // permanently fail the job, and must be logged loudly since nothing else will notice it.
  it("keeps a job pending (not failed) and logs loudly when Distribution returns 401", async () => {
    const authServer = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid token" }));
    });
    await new Promise<void>((r) => authServer.listen(0, r));
    const port = (authServer.address() as AddressInfo).port;
    try {
      const sub = await insertSubscriber(tdb.db, "unauth@example.com");
      const job = await insertJob(tdb.db, "release-401");
      await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);
      const distribution = distributionClient({ baseUrl: `http://127.0.0.1:${port}`, getToken: async () => "t" });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Distribution rejected our credentials (401/403)"));
      errorSpy.mockRestore();

      const row = (await tdb.db.select().from(sendJobs))[0]!;
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(1);
    } finally {
      authServer.close();
    }
  });

  // P2-R26: SKIP LOCKED, not just the lock predicate, keeps a claim from *waiting* on a job
  // another transaction holds — the earliest-due job here — instead of sending the others.
  it("does not wait on a send job locked by another transaction (FOR UPDATE SKIP LOCKED)", async () => {
    const subs = await Promise.all(["skl0", "skl1", "skl2"].map((e) => insertSubscriber(tdb.db, `${e}@example.com`)));
    const locked = await insertJob(tdb.db, "release-sk-0", { nextAttemptAt: new Date("2000-01-01T00:00:00Z") }); // first in claim order
    const job1 = await insertJob(tdb.db, "release-sk-1");
    const job2 = await insertJob(tdb.db, "release-sk-2");
    const jobsByIndex = [locked, job1, job2];
    await tdb.db.insert(jobRecipients).values(subs.map((s, i) => ({ jobId: jobsByIndex[i]!.id, subscriberId: s.id })));
    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "b" });

    const locker = await tdb.pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT 1 FROM send_jobs WHERE id = $1 FOR UPDATE", [locked.id]);
    try {
      const result = await Promise.race([
        sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, batchSize: 5 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sendDueJobs waited on the locked job instead of skipping it")), 5000)),
      ]);
      expect(result).toEqual({ sent: 2, retried: 0, failed: 0 });
      const keys = distribution.send.mock.calls.map((c) => (c[0] as MessageRequest).idempotencyKey);
      expect(keys.some((k) => k!.startsWith(locked.id))).toBe(false);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  }, 7000);

  // P2-R26: the terminal write is guarded by this call's lock token, not just status — if
  // another worker's claim took the job over (our lock expired mid-send), our stale outcome
  // must not overwrite whatever that worker writes.
  it("does not overwrite a job whose lock was taken over by another worker mid-send", async () => {
    const sub = await insertSubscriber(tdb.db, "stolen@example.com");
    const job = await insertJob(tdb.db, "release-stolen");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);
    const distribution = stubDistribution();
    distribution.send.mockImplementation(async () => {
      // Another worker's claim overwrites locked_until while this call is mid-send.
      await tdb.pool.query("UPDATE send_jobs SET locked_until = now() + interval '1 hour' WHERE id = $1", [job.id]);
      return { batchId: "stale" };
    });

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    const [row] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job.id));
    expect(row!.status).toBe("pending");
    expect(row!.batchIds).toEqual({});
    expect(row!.lockedUntil).not.toBeNull();
  });

  it("two concurrent runs send each due job exactly once", async () => {
    const subA = await insertSubscriber(tdb.db, "a@example.com");
    const subB = await insertSubscriber(tdb.db, "b@example.com");
    const jobA = await insertJob(tdb.db, "release-6a");
    const jobB = await insertJob(tdb.db, "release-6b");
    await tdb.db.insert(jobRecipients).values([
      { jobId: jobA.id, subscriberId: subA.id },
      { jobId: jobB.id, subscriberId: subB.id },
    ]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "batch-concurrent" });

    const [r1, r2] = await Promise.all([
      sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, batchSize: 5 }),
      sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, batchSize: 5 }),
    ]);

    expect(r1.sent + r2.sent).toBe(2);
    expect(distribution.send).toHaveBeenCalledTimes(2);
    const rows = await tdb.db.select().from(sendJobs);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });

  it("chunks recipients and resends every chunk (same keys) on a retry after a mid-batch failure", async () => {
    const subs = await Promise.all(Array.from({ length: 5 }, (_, i) => insertSubscriber(tdb.db, `r${i}@example.com`, { id: lowId(i) })));
    const job = await insertJob(tdb.db, "release-7");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    const distribution = stubDistribution();
    // chunkSize 2 over 5 recipients → chunks :0 (2), :1 (2), :2 (1). First attempt: :0 ok, :1
    // fails retryably, :2 never reached.
    distribution.send.mockImplementationOnce(async () => ({ batchId: "b0" })).mockImplementationOnce(async () => {
      throw new DistributionError("HTTP 503", true);
    });

    const now = await dbClock(tdb.db);
    const result1 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, chunkSize: 2, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(distribution.send).toHaveBeenCalledTimes(2);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:1`);

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterFirst.batchIds).toEqual({ "0": "b0" }); // fix 8: chunk 0's id survived the retry-pending state

    // Retry: resends ALL three chunks, including :0 which already succeeded.
    distribution.send.mockReset();
    distribution.send.mockResolvedValueOnce({ batchId: "b0-again" }).mockResolvedValueOnce({ batchId: "b1" }).mockResolvedValueOnce({ batchId: "b2" });
    const result2 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, chunkSize: 2, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(distribution.send).toHaveBeenCalledTimes(3);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:1`);
    expect((distribution.send.mock.calls[2]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:2`);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).recipients).toHaveLength(2);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).recipients).toHaveLength(2);
    expect((distribution.send.mock.calls[2]![0] as MessageRequest).recipients).toHaveLength(1);

    const afterSecond = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterSecond.status).toBe("sent");
    // batch_ids merges the newest response per key over whatever was stored before (here,
    // chunk 0's id legitimately changes because this test's stub isn't dedup-aware — the
    // *real* Distribution would return the original "b0", which the freezing/dedup test below
    // covers).
    expect(afterSecond.batchIds).toEqual({ "0": "b0-again", "1": "b1", "2": "b2" });
  });

  // Fix 1 (P2-R16): chunk membership must be frozen on the first attempt. Probes both halves
  // of the bug this fixes: a subscriber deleted from an already-sent chunk must not cause
  // anyone else to be re-chunked (they'd otherwise shift down and partly double-send), and a
  // new, low-id recipient added after chunking must not retroactively join any chunk.
  it("freezes chunk membership: a deletion doesn't shift anyone, and a new low-id recipient isn't picked up by a retry", async () => {
    // Explicit low, ordered ids 1..5 (0 is reserved below for the "new low-id recipient" probe
    // — it must sort lower than every original subscriber, and the nil UUID has no room
    // below it): with chunkSize 2, chunk 0 = [id(1), id(2)], chunk 1 = [id(3), id(4)], chunk
    // 2 = [id(5)].
    const subs = await Promise.all([0, 1, 2, 3, 4].map((n) => insertSubscriber(tdb.db, `orig${n}@example.com`, { id: lowId(n + 1) })));
    const job = await insertJob(tdb.db, "release-freeze");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    // Fails chunk 1 once (retryable), succeeds everywhere else, and dedupes by key exactly
    // like the real Distribution — so a resend of an already-accepted chunk is a no-op, not a
    // second mailing.
    const distribution = dedupingDistribution({ failKeyOnce: `${job.id}:1` });

    const now = await dbClock(tdb.db);
    const result1 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, chunkSize: 2, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0 });

    const chunk0Call1 = distribution.calls.find((c) => c.idempotencyKey === `${job.id}:0`)!;
    expect(chunk0Call1.recipients.map((r) => r.email).sort()).toEqual(["orig0@example.com", "orig1@example.com"]);

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;

    // Between attempts: delete one subscriber from the already-accepted chunk 0, and add a
    // brand new recipient whose subscriber id sorts lower than every existing one — if chunking
    // were re-derived instead of frozen, this would become the new chunk 0's first member and
    // bump everyone else down by one slot.
    await tdb.db.delete(subscribers).where(eq(subscribers.id, lowId(1)));
    const lateSub = await insertSubscriber(tdb.db, "late@example.com", { id: lowId(0) });
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: lateSub.id }]);

    const result2 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, chunkSize: 2, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0 });

    // This attempt's (second, final) recipient set per chunk — the proof that chunking was
    // frozen: chunk 0 lost exactly its deleted member (shrank in place, 2→1) without anyone
    // from chunk 1 or chunk 2 sliding down to backfill it, and chunks 1/2 are byte-identical
    // to attempt 1 (same two people, same singleton) despite the deletion and the new recipient.
    const secondAttemptByKey = new Map<string, Set<string>>();
    for (const call of distribution.calls.slice(2)) {
      secondAttemptByKey.set(call.idempotencyKey!, new Set(call.recipients.map((r) => r.email)));
    }
    const byKey = secondAttemptByKey;

    // The deleted subscriber's own chunk shrank in place (1 remaining member, not backfilled
    // from chunk 1), and the late recipient was never sent to at all.
    expect([...byKey.get(`${job.id}:0`)!]).toEqual(["orig1@example.com"]);
    expect([...byKey.get(`${job.id}:1`)!].sort()).toEqual(["orig2@example.com", "orig3@example.com"]);
    expect([...byKey.get(`${job.id}:2`)!]).toEqual(["orig4@example.com"]);
    expect(distribution.calls.some((c) => c.recipients.some((r) => r.email === "late@example.com"))).toBe(false);

    // Every remaining original person (4, after the deletion) was mailed — exactly the people
    // above, no more, no fewer.
    const everyoneMailed = new Set([...byKey.values()].flatMap((s) => [...s]));
    expect(everyoneMailed).toEqual(new Set(["orig1@example.com", "orig2@example.com", "orig3@example.com", "orig4@example.com"]));
  });

  // Fix 1 (P2-R18): ensureChunksAssigned's chunk_index write and its chunks_assigned flag
  // write must commit together — otherwise a crash between them (chunk_index assigned, flag
  // never set) plus a recipient arriving before the next attempt lets that recipient get
  // renumbered into an already-full chunk 0, overflowing it past chunkSize.
  it("assigns chunks atomically: a failure before the flag write rolls back the chunk_index assignment too", async () => {
    const subs = await Promise.all([0, 1, 2, 3].map((n) => insertSubscriber(tdb.db, `atomic${n}@example.com`, { id: lowId(n + 1) })));
    const job = await insertJob(tdb.db, "release-atomic");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    // Simulates the old crash shape: the chunk_index UPDATE runs, then (inside the same
    // transaction) something throws before the chunks_assigned flag write.
    await expect(
      ensureChunksAssigned(tdb.db, job.id, 2, {
        onBeforeFlagWrite: () => {
          throw new Error("simulated crash before the flag write");
        },
      }),
    ).rejects.toThrow("simulated crash before the flag write");

    // Rolled back: chunk_index is still NULL for everyone, and the flag is still false — not
    // the old "assigned but not flagged" half-done state.
    let rows = await tdb.db.select({ chunkIndex: jobRecipients.chunkIndex }).from(jobRecipients).where(eq(jobRecipients.jobId, job.id));
    expect(rows.every((r) => r.chunkIndex === null)).toBe(true);
    const [jobRow] = await tdb.db.select({ chunksAssigned: sendJobs.chunksAssigned }).from(sendJobs).where(eq(sendJobs.id, job.id));
    expect(jobRow!.chunksAssigned).toBe(false);

    // A recipient arrives between the (rolled-back) crash and the retry. With atomic
    // assignment this is just one more row in the same still-fully-unassigned pool — it gets
    // numbered in with everyone else, not appended onto an already-"committed" chunk 0.
    const lateSub = await insertSubscriber(tdb.db, "atomiclate@example.com", { id: lowId(5) });
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: lateSub.id }]);

    await ensureChunksAssigned(tdb.db, job.id, 2);

    rows = await tdb.db.select({ chunkIndex: jobRecipients.chunkIndex }).from(jobRecipients).where(eq(jobRecipients.jobId, job.id));
    expect(rows.every((r) => r.chunkIndex !== null)).toBe(true);
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.chunkIndex!, (counts.get(r.chunkIndex!) ?? 0) + 1);
    // 5 recipients at chunkSize 2 → sizes [2, 2, 1]; no chunk ever exceeds chunkSize.
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(counts.size).toBe(3);
  });
});

describe("MAX_RECIPIENTS_PER_CHUNK", () => {
  it("is Distribution's own per-request recipient limit", () => {
    expect(MAX_RECIPIENTS_PER_CHUNK).toBe(20_000);
  });
});

describe("MAX_CHUNK_BYTES", () => {
  it("is 8 MB", () => {
    expect(MAX_CHUNK_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("sendDueJobs chunk byte-splitting (M3)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder: nodMigrations });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE send_jobs, job_recipients, subscribers CASCADE");
  });

  // M3: a chunk under MAX_RECIPIENTS_PER_CHUNK can still produce an oversized JSON payload.
  // With a tiny maxChunkBytes override, even a 4-recipient chunk must be split into several
  // smaller requests, each addressed by its own stable sub-key (so retries target the same
  // Distribution idempotencyKey every time).
  it("splits a single chunk into several smaller requests when its payload would exceed maxChunkBytes", async () => {
    const subs = await Promise.all(Array.from({ length: 4 }, (_, i) => insertSubscriber(tdb.db, `big${i}@example.com`, { id: lowId(i) })));
    const job = await insertJob(tdb.db, "release-bytes");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "b" });

    // Small enough that a single recipient's own request already exceeds it, forcing a split
    // all the way down to one recipient per request (4 recipients -> 4 requests).
    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, maxChunkBytes: 50 });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(distribution.send).toHaveBeenCalledTimes(4);
    const keys = distribution.send.mock.calls.map((c) => (c[0] as MessageRequest).idempotencyKey).sort();
    expect(keys).toEqual([`${job.id}:0.0`, `${job.id}:0.1`, `${job.id}:0.2`, `${job.id}:0.3`]);
    for (const call of distribution.send.mock.calls) {
      expect((call[0] as MessageRequest).recipients).toHaveLength(1);
    }

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("sent");
    expect(Object.keys(row.batchIds).sort()).toEqual(["0.0", "0.1", "0.2", "0.3"]);
  });

  it("does not split a chunk whose payload fits within the default maxChunkBytes", async () => {
    const subs = await Promise.all(Array.from({ length: 4 }, (_, i) => insertSubscriber(tdb.db, `small${i}@example.com`, { id: lowId(i) })));
    const job = await insertJob(tdb.db, "release-nobytes");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "b" });

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(distribution.send).toHaveBeenCalledTimes(1);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
  });

  // R3: the byte-split partition must be computed over the chunk's *frozen* membership
  // (active or not), not over whichever subset happens to be active right now — otherwise
  // a subscriber flipping inactive between attempts shrinks the list splitChunkByBytes sizes
  // against, which can renumber every other member's part key out from under them.
  it("keeps identical byte-split keys on retry when a subscriber in one part becomes inactive between attempts (R3)", async () => {
    const subs = await Promise.all([0, 1, 2, 3].map((n) => insertSubscriber(tdb.db, `r3-${n}@example.com`, { id: lowId(n) })));
    const job = await insertJob(tdb.db, "release-r3-stable-keys");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    const distribution = stubDistribution();
    // maxChunkBytes: 50 forces a 1-member-per-part split (as in the test above) -> parts
    // 0.0, 0.1, 0.2, 0.3. First attempt: 0.0 and 0.1 are accepted, 0.2 fails retryably, 0.3 is
    // never reached.
    distribution.send
      .mockImplementationOnce(async () => ({ batchId: "b0" }))
      .mockImplementationOnce(async () => ({ batchId: "b1" }))
      .mockImplementationOnce(async () => {
        throw new DistributionError("HTTP 503", true);
      });

    const now = await dbClock(tdb.db);
    const result1 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, maxChunkBytes: 50, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(distribution.send).toHaveBeenCalledTimes(3);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0.0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0.1`);
    expect((distribution.send.mock.calls[2]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0.2`);

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterFirst.batchIds).toEqual({ "0.0": "b0", "0.1": "b1" });

    // Between attempts: the subscriber whose sole membership is part 0.1 becomes inactive.
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, subs[1]!.id));

    distribution.send.mockReset();
    distribution.send.mockResolvedValue({ batchId: "retry" });
    const result2 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, maxChunkBytes: 50, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0 });

    // Part 0.1's sole member is now inactive, so that part is skipped entirely this attempt
    // — but the *other* parts keep their original keys (0.0, 0.2, 0.3), not renumbered as if
    // only 3 members had ever existed.
    const keysUsed = distribution.send.mock.calls.map((c) => (c[0] as MessageRequest).idempotencyKey).sort();
    expect(keysUsed).toEqual([`${job.id}:0.0`, `${job.id}:0.2`, `${job.id}:0.3`]);

    const afterSecond = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterSecond.status).toBe("sent");
    // 0.1's batchId from the first attempt survives untouched — it was never re-sent, just
    // skipped, since nothing in it is currently active.
    expect(Object.keys(afterSecond.batchIds).sort()).toEqual(["0.0", "0.1", "0.2", "0.3"]);
    expect(afterSecond.batchIds["0.1"]).toBe("b1");
  });
});

describe("distributionClient", () => {
  let server: Server;
  let baseUrl: string;
  let lastAuthHeader: string | undefined;
  let respondStatus: number;
  let respondBody: unknown;

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastAuthHeader = req.headers.authorization;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.statusCode = respondStatus;
        res.setHeader("content-type", "application/json");
        res.end(typeof respondBody === "string" ? respondBody : JSON.stringify(respondBody));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });
  afterEach(() => {
    respondStatus = 200;
    respondBody = {};
  });

  const sampleRequest: MessageRequest = {
    priority: "immediate",
    subject: "Hi",
    html: "<p>hi</p>",
    headers: {},
    recipients: [{ email: "a@example.com", substitutions: {} }],
  };

  it("sends the bearer token and returns the batchId on 202", async () => {
    respondStatus = 202;
    respondBody = { batchId: "batch-new" };
    const client = distributionClient({ baseUrl, getToken: async () => "the-token" });

    const res = await client.send(sampleRequest);
    expect(res).toEqual({ batchId: "batch-new" });
    expect(lastAuthHeader).toBe("Bearer the-token");
  });

  it("returns the batchId on 200 (already existed)", async () => {
    respondStatus = 200;
    respondBody = { batchId: "batch-existing" };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    expect(await client.send(sampleRequest)).toEqual({ batchId: "batch-existing" });
  });

  // Fix 10 (P2-R16): any 2xx is success, not just the two Distribution happens to use today.
  it("treats any 2xx (e.g. 201) as success", async () => {
    respondStatus = 201;
    respondBody = { batchId: "batch-201" };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    expect(await client.send(sampleRequest)).toEqual({ batchId: "batch-201" });
  });

  it("maps 503 to a retryable DistributionError", async () => {
    respondStatus = 503;
    respondBody = "service unavailable";
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true, status: 503 });
  });

  it("maps 400 to a non-retryable DistributionError", async () => {
    respondStatus = 400;
    respondBody = { error: "invalid request" };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: false, status: 400 });
  });

  // Fix 3 (P2-R16): 401/403 are retryable (a credentials problem is usually transient) and
  // logged loudly, unlike every other 4xx.
  it("maps 401 to a retryable DistributionError and logs loudly", async () => {
    respondStatus = 401;
    respondBody = { error: "invalid token" };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true, status: 401 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Distribution rejected our credentials (401/403)"));
    errorSpy.mockRestore();
  });

  it("maps 403 to a retryable DistributionError", async () => {
    respondStatus = 403;
    respondBody = { error: "forbidden" };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true, status: 403 });
  });

  it("maps a network error to a retryable DistributionError", async () => {
    const client = distributionClient({ baseUrl: "http://127.0.0.1:1", getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true });
  });

  // Fix 2 (P2-R16): getToken failing is retryable — the request to Distribution was never
  // even attempted.
  it("maps a getToken failure to a retryable DistributionError", async () => {
    const client = distributionClient({ baseUrl, getToken: async () => Promise.reject(new Error("token endpoint HTTP 503")) });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true });
  });

  // Fix 2 (P2-R16): an unreadable/malformed 2xx body is retryable, not a thrown TypeError that
  // escapes send-jobs.ts uncaught.
  it("maps an unparseable 2xx body to a retryable DistributionError", async () => {
    respondStatus = 202;
    respondBody = "not json";
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true });
  });

  // Fix 3 (P2-R18): a 2xx body that parses as JSON but has no usable batchId is just as
  // dangerous as an unreadable one — send-jobs.ts would otherwise store a missing/empty id as
  // "the" record of this chunk's acceptance, permanently.
  it("maps a 2xx body with a missing batchId to a retryable DistributionError", async () => {
    respondStatus = 202;
    respondBody = {};
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true, status: 202 });
    await expect(client.send(sampleRequest)).rejects.toThrow(/missing batchId/);
  });

  it("maps a 2xx body with an empty-string batchId to a retryable DistributionError", async () => {
    respondStatus = 202;
    respondBody = { batchId: "" };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true });
  });

  it("maps a 2xx body with a non-string batchId to a retryable DistributionError", async () => {
    respondStatus = 202;
    respondBody = { batchId: 12345 };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true });
  });

  // Fix 4 (P2-R16): getToken is bounded by the same timeout as the request itself.
  it("times out a hanging getToken instead of waiting forever", async () => {
    const client = distributionClient({
      baseUrl,
      getToken: () => new Promise<string>(() => {}), // never resolves
      timeoutMs: 20,
    });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true });
  });
});
