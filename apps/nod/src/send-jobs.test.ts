import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createTestDatabase, dbClock } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createItemSending } from "./as-it-happens";
import { DistributionError, distributionClient, type DistributionClient, type MessageRequest } from "./distribution-client";
import { deliveries, items, jobRecipients, sendJobs, subscriberLinks, subscribers } from "./db/schema";
import { upsertReleaseItem, withdrawItem } from "./items";
import { placeholderLinkLengths, type RecipientLinkOptions } from "./recipient-links";
import type { RenderOptions } from "./render";
import { MAX_CHUNK_BYTES, MAX_RECIPIENTS_PER_CHUNK, ensureChunksAssigned, sendDueJobs } from "./send-jobs";
import { addSubscriber } from "./subscribers";

const PUBLIC_SITE_URL = "https://news.example/site";
const RENDER: RenderOptions = { siteUrl: PUBLIC_SITE_URL, bannerUrl: null };

const nodMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
const SUBSCRIBE_API_URL = "https://news.example/api/Subscribe";
const LINKS: RecipientLinkOptions = {
  pageUrl: "https://news.example/subscribe/manage",
  subscribeApiUrl: SUBSCRIBE_API_URL,
  linkSecret: "test-link-secret-at-least-32-chars-long",
};

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

async function insertJob(db: TestDatabase["db"], itemKey: string | null, overrides: Partial<typeof sendJobs.$inferInsert> = {}) {
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
      // A real (not just unique) uuid -- it's written to deliveries.distribution_batch_id.
      const batchId = `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
      accepted.set(key, batchId);
      return { batchId };
    },
  } as unknown as DistributionClient & { calls: MessageRequest[] };
}

/**
 * Wraps a real test `db` so that the very first `INSERT INTO subscriber_links`
 * it sees (recipientSubstitutions' own insert, called from inside sendAllChunks) runs
 * `onBeforeInsert` first — lands a subscriber deletion exactly in the gap between
 * `fetchAssignedMembers` reading the row and `recipientSubstitutions` writing a link row for
 * it, the real-world trigger the review called out (subscriber_links.subscriber_id's FK),
 * without needing to actually win a race. Every other call is forwarded to the real `db`,
 * bound to it so drizzle's own `this` usage is untouched.
 */
function dbThatRunsBeforeLinkInsert(db: TestDatabase["db"], onBeforeInsert: () => Promise<void>): TestDatabase["db"] {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "insert") {
        return (table: unknown) => {
          const builder = (target.insert as (t: unknown) => { values: (v: unknown) => unknown })(table as never);
          if (table !== subscriberLinks) return builder;
          return {
            values: async (rows: unknown) => {
              await onBeforeInsert();
              return builder.values(rows);
            },
          };
        };
      }
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop as string];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TestDatabase["db"];
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
    await tdb.pool.query("TRUNCATE TABLE send_jobs, job_recipients, subscribers, items CASCADE");
    await tdb.pool.query("UPDATE nod_settings SET paused = false");
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
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000006" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.idempotencyKey).toBe(`${job.id}:0`);
    expect(req.headers).toEqual({ "List-Unsubscribe": "<{{unsubscribeUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(req.recipients.map((r) => r.email).sort()).toEqual(["alex@example.com", "sam@example.com"]);

    const updated = (await tdb.db.select().from(sendJobs))[0]!;
    expect(updated.status).toBe("sent");
    expect(updated.batchIds).toEqual({ "0": "00000000-0000-4000-8000-000000000006" });
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
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-00000000000f" });
    await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });

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
    const result1 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(afterFirst.lockedUntil).toBeNull();

    distribution.send.mockResolvedValueOnce({ batchId: "00000000-0000-4000-8000-000000000007" });
    // The backoff was computed from the database's now() (µs); a JS Date of it is truncated to
    // the millisecond, so the test clock is set 1ms past it to be on or after the real value.
    const result2 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, now: () => new Date(afterFirst.nextAttemptAt.getTime() + 1) });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    expect(distribution.send).toHaveBeenCalledTimes(2);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);

    const afterSecond = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterSecond.status).toBe("sent");
    expect(afterSecond.batchIds).toEqual({ "0": "00000000-0000-4000-8000-000000000007" });
  });

  it("fails immediately on a non-retryable error", async () => {
    const sub = await insertSubscriber(tdb.db, "bad@example.com");
    const job = await insertJob(tdb.db, "release-4");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new DistributionError("HTTP 400: invalid subject", false));

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 1, cancelled: 0, paused: false });

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
      const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
      expect(result).toEqual({ sent: 0, retried: 0, failed: 1, cancelled: 0, paused: false });
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
      const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
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
    distribution.send.mockResolvedValueOnce({ batchId: "00000000-0000-4000-8000-000000000010" }).mockRejectedValueOnce(new DistributionError("HTTP 400: bad subject", false));

    // chunkSize 1 over 3 recipients → 3 chunks; chunk 0 succeeds, chunk 1 fails permanently,
    // chunk 2 is never attempted.
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 1 });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 1, cancelled: 0, paused: false });

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("failed");
    expect(row.batchIds).toEqual({ "0": "00000000-0000-4000-8000-000000000010" });
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
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, now: () => future });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 1, cancelled: 0, paused: false });

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

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });

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

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });

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
      const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
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
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000001" });

    const locker = await tdb.pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT 1 FROM send_jobs WHERE id = $1 FOR UPDATE", [locked.id]);
    try {
      const result = await Promise.race([
        sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, batchSize: 5 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sendDueJobs waited on the locked job instead of skipping it")), 5000)),
      ]);
      expect(result).toEqual({ sent: 2, retried: 0, failed: 0, cancelled: 0, paused: false });
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
      return { batchId: "00000000-0000-4000-8000-000000000013" };
    });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0, paused: false });
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
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000009" });

    const [r1, r2] = await Promise.all([
      sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, batchSize: 5 }),
      sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, batchSize: 5 }),
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
    distribution.send.mockImplementationOnce(async () => ({ batchId: "00000000-0000-4000-8000-000000000002" })).mockImplementationOnce(async () => {
      throw new DistributionError("HTTP 503", true);
    });

    const now = await dbClock(tdb.db);
    const result1 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 2, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
    expect(distribution.send).toHaveBeenCalledTimes(2);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:1`);

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterFirst.batchIds).toEqual({ "0": "00000000-0000-4000-8000-000000000002" }); // fix 8: chunk 0's id survived the retry-pending state

    // Retry: resends ALL three chunks, including :0 which already succeeded.
    distribution.send.mockReset();
    distribution.send.mockResolvedValueOnce({ batchId: "00000000-0000-4000-8000-000000000003" }).mockResolvedValueOnce({ batchId: "00000000-0000-4000-8000-000000000004" }).mockResolvedValueOnce({ batchId: "00000000-0000-4000-8000-000000000005" });
    const result2 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 2, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

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
    // *real* Distribution would return the original id again, which the freezing/dedup test
    // below covers).
    expect(afterSecond.batchIds).toEqual({ "0": "00000000-0000-4000-8000-000000000003", "1": "00000000-0000-4000-8000-000000000004", "2": "00000000-0000-4000-8000-000000000005" });
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
    const result1 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 2, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });

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

    const result2 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 2, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

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

  // Global constraint: while nod_settings.paused is true the sender claims nothing — items,
  // deliveries and jobs keep recording normally (elsewhere), but sendDueJobs itself must not
  // touch send_jobs at all.
  it("paused: claims nothing; resumed: sends", async () => {
    const sub = await insertSubscriber(tdb.db, "paused@example.com");
    const job = await insertJob(tdb.db, "release-paused");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-00000000000d" });

    await tdb.pool.query("UPDATE nod_settings SET paused = true");
    const pausedResult = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(pausedResult).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0, paused: true });
    expect(distribution.send).not.toHaveBeenCalled();
    const stillPending = (await tdb.db.select().from(sendJobs))[0]!;
    expect(stillPending.status).toBe("pending");
    expect(stillPending.lockedUntil).toBeNull();

    await tdb.pool.query("UPDATE nod_settings SET paused = false");
    const resumedResult = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(resumedResult).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });
  });

  // Global constraint / review focus 2: a release unpublished before the sender ran must
  // never be mailed — its pending job is cancelled, not sent.
  it("withdrawn item's job is cancelled, nothing sent", async () => {
    await tdb.db.insert(items).values({
      key: "release-withdrawn",
      kind: "release",
      title: "Withdrawn release",
      url: "https://news.example/releases/release-withdrawn",
      publishedAt: new Date(),
      withdrawnAt: new Date(),
    });
    const sub = await insertSubscriber(tdb.db, "withdrawn@example.com");
    const job = await insertJob(tdb.db, "release-withdrawn");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 1, paused: false });
    expect(distribution.send).not.toHaveBeenCalled();

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("cancelled");
    expect(row.lockedUntil).toBeNull();
  });

  // Per-recipient links (Task 3): each active recipient gets a manage link of their own and
  // the stable one-click unsubscribe URL; the List-Unsubscribe header carries the placeholder
  // Distribution substitutes per recipient.
  it("each recipient gets their own manage and one-click URLs, and the List-Unsubscribe header uses the placeholder", async () => {
    const alex = await insertSubscriber(tdb.db, "alex-links@example.com");
    const sam = await insertSubscriber(tdb.db, "sam-links@example.com");
    const job = await insertJob(tdb.db, "release-links");
    await tdb.db.insert(jobRecipients).values([
      { jobId: job.id, subscriberId: alex.id },
      { jobId: job.id, subscriberId: sam.id },
    ]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-00000000000b" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.headers).toEqual({ "List-Unsubscribe": "<{{unsubscribeUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(req.recipients).toHaveLength(2);
    const manageUrls = req.recipients.map((r) => r.substitutions.manageUrl);
    for (const url of manageUrls) expect(url).toContain("token=");
    expect(manageUrls[0]).not.toBe(manageUrls[1]);
    for (const r of req.recipients) expect(r.substitutions.unsubscribeUrl).toMatch(new RegExp(`^${SUBSCRIBE_API_URL}/OneClickUnsubscribe/`));
  });

  it("uses the job's priority", async () => {
    const sub = await insertSubscriber(tdb.db, "priority@example.com");
    const job = await insertJob(tdb.db, "release-priority", { priority: "digest" });
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-00000000000e" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.priority).toBe("digest");
  });

  // A media job carries kind='media'/priority='media' (send-jobs.ts has no special
  // branch for it -- same chunking, links and List-Unsubscribe header as every other job).
  it("sends a media job with priority 'media', the List-Unsubscribe header, and per-recipient substitutions", async () => {
    const sub = await insertSubscriber(tdb.db, "media-job@example.com");
    const job = await insertJob(tdb.db, "release-media", { jobKey: "media:release-media", kind: "media", priority: "media" });
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-00000000000c" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.priority).toBe("media");
    expect(req.headers).toEqual({ "List-Unsubscribe": "<{{unsubscribeUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(req.recipients).toHaveLength(1);
    expect(req.recipients[0]!.substitutions.manageUrl).toContain("token=");
    expect(req.recipients[0]!.substitutions.unsubscribeUrl).toMatch(new RegExp(`^${SUBSCRIBE_API_URL}/OneClickUnsubscribe/`));
  });

  // Recipients come from job_recipients (one row per subscriber per job), not from deliveries
  // (which can carry several rows per subscriber — one per item a digest bundles) — so a
  // subscriber is only ever in one recipient list per job, however many deliveries back it.
  it("a digest job with several delivery rows per subscriber sends each subscriber once", async () => {
    const subA = await insertSubscriber(tdb.db, "digest-a@example.com");
    const subB = await insertSubscriber(tdb.db, "digest-b@example.com");
    const job = await insertJob(tdb.db, null, { jobKey: "digest:2026-10-05T17:00:00Z", priority: "digest", kind: "digest" });
    await tdb.db.insert(jobRecipients).values([
      { jobId: job.id, subscriberId: subA.id },
      { jobId: job.id, subscriberId: subB.id },
    ]);
    await tdb.db.insert(deliveries).values([
      { itemKey: "release-digest-1", subscriberId: subA.id, mode: "digest", jobId: job.id },
      { itemKey: "release-digest-2", subscriberId: subA.id, mode: "digest", jobId: job.id },
      { itemKey: "release-digest-1", subscriberId: subB.id, mode: "digest", jobId: job.id },
    ]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-00000000000a" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });
    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.recipients).toHaveLength(2);
  });

  // Logs constraint: a DB error from recipientSubstitutions must never leak
  // a bound email address into send_jobs.last_error or the console — drizzle's own
  // DrizzleQueryError message binds every param of the failed query (including each row's
  // email), so `e.message` is unsafe for anything that isn't already a DistributionError.
  it("never leaks an email address into last_error or the console when recipientSubstitutions fails", async () => {
    const leaky = await insertSubscriber(tdb.db, "address-must-not-leak@example.com");
    const job = await insertJob(tdb.db, "release-leak");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: leaky.id }]);

    // Deletes the subscriber right as recipientSubstitutions goes to insert its manage-link
    // row — subscriber_links.subscriber_id's FK then rejects the insert, the realistic trigger
    // the review called out (a subscriber deleted between fetchAssignedMembers and the write).
    const dbForTest = dbThatRunsBeforeLinkInsert(tdb.db, () => tdb.pool.query("DELETE FROM subscribers WHERE id = $1", [leaky.id]).then(() => undefined));

    const distribution = stubDistribution();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof sendDueJobs>>;
    try {
      result = await sendDueJobs({ db: dbForTest, distribution, links: LINKS, render: RENDER });
    } finally {
      const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join("\n");
      expect(logged).not.toContain("address-must-not-leak@example.com");
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
    expect(distribution.send).not.toHaveBeenCalled();

    const row = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job.id)))[0]!;
    expect(row.lastError).toContain("unexpected send error");
    expect(row.lastError).not.toContain("address-must-not-leak@example.com");
  });

  // withdrawItem (items.ts) never locks the `items` row before selecting the
  // unclaimed jobs to delete, so sendDueJobs's own withdrawn-item check must take its own lock
  // (FOR SHARE) to avoid reading an uncommitted (pre-withdraw) NULL. Here withdrawItem's
  // transaction is held open — committing only after a delay — while a job for the very item
  // it just marked withdrawn is created and claimed; the claim's withdrawn_at read must block
  // behind the open transaction and see the committed value once it lands.
  it("a withdraw racing the sender is linearized: the sender never reads an uncommitted withdrawn_at", async () => {
    await tdb.db.insert(items).values({
      key: "release-race",
      kind: "release",
      title: "Race release",
      url: "https://news.example/releases/release-race",
      publishedAt: new Date(),
    });

    let committed = false;
    const withdrawDone = tdb.db.transaction(async (tx) => {
      // No jobs exist for this item yet, so withdrawItem's own cleanup has nothing to do —
      // the race under test is purely about the withdrawn_at read below, not job deletion.
      await withdrawItem(tx, "release-race");
      await new Promise((r) => setTimeout(r, 300));
      committed = true;
    });

    // Let withdrawItem's UPDATE land (and its row lock take hold) before the job even exists.
    await new Promise((r) => setTimeout(r, 50));
    const sub = await insertSubscriber(tdb.db, "race@example.com");
    const job = await insertJob(tdb.db, "release-race");
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000012" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    await withdrawDone;

    // sendDueJobs only returned because its FOR SHARE read unblocked — which only happens once
    // withdrawItem's transaction committed, so this must already be true.
    expect(committed).toBe(true);
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 1, paused: false });
    expect(distribution.send).not.toHaveBeenCalled();

    const row = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job.id)))[0]!;
    expect(row.status).toBe("cancelled");
  });

  // The withdrawn-check read and the cancel write must happen in one
  // transaction, or a republish that lands entirely in the gap between them (upsertReleaseItem
  // clearing withdrawn_at, then createItemSend, both inside one transaction — as-it-happens.ts)
  // can leave the item live with only a cancelled job and nothing fresh to send it. The
  // republish is kicked off (not awaited) from onWithdrawnCheck — which fires while this call's
  // own transaction still holds the FOR SHARE lock — so its own UPDATE on the same items row
  // must block behind this call's transaction rather than racing it: either this call's cancel
  // commits first and the republish's createItemSend then finds the job 'cancelled' (replacing
  // it with a fresh one, per the controller ruling), or the republish commits first and this
  // call's read sees the already-cleared withdrawn_at and sends normally. Either way, the item
  // never ends up live with only a cancelled job.
  it("a republish racing the sender's cancel write is linearized: the item ends with one live job, never a live item with only a cancelled one", async () => {
    const release = { ...sampleRelease, key: "release-republish-race", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => upsertReleaseItem(tx, release, PUBLIC_SITE_URL));
    await tdb.db.update(items).set({ withdrawnAt: new Date() }).where(eq(items.key, release.key));

    // addSubscriber (not the local insertSubscriber helper) because createItemSend's own
    // recipient match (matchesItem, inside the republish below) needs a real `subscriptions`
    // row, not just a `subscribers` row — '*' matches this release via its ministries key.
    const sub = await addSubscriber(tdb.db, { email: "republish-race@example.com", lists: "all" });
    const job = await insertJob(tdb.db, release.key);
    await tdb.db.insert(jobRecipients).values([{ jobId: job.id, subscriberId: sub.id }]);

    const { createItemSend } = createItemSending({ render: RENDER });
    let republishDone: Promise<boolean> | undefined;
    const onWithdrawnCheck = () => {
      // Fire-and-forget: must not be awaited here, or the sender's own transaction (which the
      // republish's UPDATE needs to wait out) could never reach its cancel write and commit.
      republishDone = tdb.db.transaction(async (tx) => {
        await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
        return createItemSend(tx, release.key, "as_it_happens");
      });
    };

    const distribution = stubDistribution();
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, onWithdrawnCheck });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 1, paused: false });
    expect(distribution.send).not.toHaveBeenCalled();

    expect(republishDone).toBeDefined();
    expect(await republishDone).toBe(true);

    const [item] = await tdb.db.select().from(items).where(eq(items.key, release.key));
    expect(item!.withdrawnAt).toBeNull();

    const jobs = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("pending");
    expect(jobs[0]!.id).not.toBe(job.id); // the original job was deleted, not revived

    const recipientRows = await tdb.db.select().from(jobRecipients).where(eq(jobRecipients.jobId, jobs[0]!.id));
    expect(recipientRows.map((r) => r.subscriberId)).toEqual([sub.id]);
  }, 7000);

  // deliveries.attempted_at is stamped right before a part is handed to
  // Distribution, not after a successful response — so every part actually handed off this
  // attempt is stamped, whether or not it ultimately succeeds, while a part skipped because
  // nobody in it is active is never touched, and a retry never re-stamps (nor un-stamps) a
  // part already marked. chunkSize 1 over 3 recipients ordered active, inactive, active: chunk
  // 0 (active) succeeds, chunk 1 (inactive) is skipped entirely, chunk 2 (active) fails
  // retryably — stopping the attempt before any chunk 3 would exist anyway.
  it("stamps deliveries.attempted_at before handing a part to Distribution, once, leaving inactive members and other jobs untouched", async () => {
    const subs = await Promise.all([
      insertSubscriber(tdb.db, "attempted-active-0@example.com", { id: lowId(0) }),
      insertSubscriber(tdb.db, "attempted-inactive-1@example.com", { id: lowId(1), active: false }),
      insertSubscriber(tdb.db, "attempted-active-2@example.com", { id: lowId(2) }),
    ]);
    const job = await insertJob(tdb.db, "release-attempted");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));
    await tdb.db.insert(deliveries).values(subs.map((s) => ({ itemKey: "release-attempted", subscriberId: s.id, mode: "as_it_happens" as const, jobId: job.id })));

    // A delivery for a different job must never be touched by this job's sends.
    const otherSub = await insertSubscriber(tdb.db, "attempted-other-job@example.com");
    // Not pending — never claimed by this test's sendDueJobs calls, so it can't itself skew
    // `result` (only its untouched attempted_at is what this test cares about).
    const otherJob = await insertJob(tdb.db, "release-attempted-other", { status: "sent" });
    await tdb.db.insert(deliveries).values([{ itemKey: "release-attempted-other", subscriberId: otherSub.id, mode: "as_it_happens" as const, jobId: otherJob.id }]);

    const distribution = stubDistribution();
    // Calls happen only for the two active chunks (0 and 2) — chunk 1 (inactive) never calls
    // distribution.send at all.
    distribution.send.mockImplementationOnce(async () => ({ batchId: "00000000-0000-4000-8000-000000000002" })).mockImplementationOnce(async () => {
      throw new DistributionError("HTTP 503", true);
    });

    const attemptedAtFor = async (subscriberId: string) => {
      const [row] = await tdb.db.select({ attemptedAt: deliveries.attemptedAt }).from(deliveries).where(and(eq(deliveries.jobId, job.id), eq(deliveries.subscriberId, subscriberId)));
      return row?.attemptedAt ?? null;
    };

    const now = await dbClock(tdb.db);
    const result1 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 1, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
    expect(distribution.send).toHaveBeenCalledTimes(2); // chunk 0 and chunk 2; chunk 1 (inactive) skipped

    const stamp0First = await attemptedAtFor(subs[0]!.id);
    expect(stamp0First).not.toBeNull(); // chunk 0: handed off and accepted
    const stamp2First = await attemptedAtFor(subs[2]!.id);
    expect(stamp2First).not.toBeNull(); // chunk 2: handed off even though the send then failed
    expect(await attemptedAtFor(subs[1]!.id)).toBeNull(); // chunk 1: inactive, never handed off
    const otherStamp = (await tdb.db.select({ attemptedAt: deliveries.attemptedAt }).from(deliveries).where(eq(deliveries.jobId, otherJob.id)))[0]!.attemptedAt;
    expect(otherStamp).toBeNull(); // a different job's delivery is never touched

    // Retry: chunk 0 is resent (already stamped — must not move) and chunk 2 now succeeds.
    distribution.send.mockReset();
    distribution.send.mockResolvedValueOnce({ batchId: "00000000-0000-4000-8000-000000000003" }).mockResolvedValueOnce({ batchId: "00000000-0000-4000-8000-000000000005" });
    const afterFirst = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job.id)))[0]!;
    const result2 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 1, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    expect((await attemptedAtFor(subs[0]!.id))!.getTime()).toBe(stamp0First!.getTime()); // unchanged by the retry
    expect((await attemptedAtFor(subs[2]!.id))!.getTime()).toBe(stamp2First!.getTime()); // unchanged by the retry — stamped on attempt 1, before the throw
    expect(await attemptedAtFor(subs[1]!.id)).toBeNull(); // still inactive, still never handed off
  });

  // After a part is handed off and Distribution accepts it, the batchId it returned is
  // stamped onto that part's deliveries (distribution_batch_id) -- what bounces.ts's own
  // first match attempt looks for. A part whose send fails gets no batchId at all (there's
  // nothing to record), even though attempted_at was still stamped for it.
  it("records distribution_batch_id on a part's deliveries once Distribution accepts it, and not on a part that fails", async () => {
    const subs = await Promise.all([
      insertSubscriber(tdb.db, "batchid-active-0@example.com", { id: lowId(0) }),
      insertSubscriber(tdb.db, "batchid-active-2@example.com", { id: lowId(2) }),
    ]);
    const job = await insertJob(tdb.db, "release-batchid");
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));
    await tdb.db.insert(deliveries).values(subs.map((s) => ({ itemKey: "release-batchid", subscriberId: s.id, mode: "as_it_happens" as const, jobId: job.id })));

    const distribution = stubDistribution();
    distribution.send.mockImplementationOnce(async () => ({ batchId: "00000000-0000-4000-8000-000000000008" })).mockImplementationOnce(async () => {
      throw new DistributionError("HTTP 503", true);
    });

    const batchIdFor = async (subscriberId: string) => {
      const [row] = await tdb.db.select({ distributionBatchId: deliveries.distributionBatchId }).from(deliveries).where(and(eq(deliveries.jobId, job.id), eq(deliveries.subscriberId, subscriberId)));
      return row?.distributionBatchId ?? null;
    };

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, chunkSize: 1 });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
    expect(distribution.send).toHaveBeenCalledTimes(2);

    expect(await batchIdFor(subs[0]!.id)).toBe("00000000-0000-4000-8000-000000000008");
    expect(await batchIdFor(subs[1]!.id)).toBeNull(); // this part's send threw -- nothing to record
  });

  // Defence in depth: Media Hub's own contract doesn't require `.email()` on `address`
  // (media-hub/contract.ts), so a stale row with an invalid stored address must never reach
  // Distribution's own z.string().email() check -- that answers 400 for the *whole* request,
  // failing this part and every later part of the job. One recipient in the part has an
  // invalid address (inserted directly, bypassing the app's own write-time validation, to
  // stand in for a row written before that validation existed); the other is valid.
  it("drops a recipient with an invalid stored email address, sending only the valid one; the job still succeeds and the invalid one's delivery stays unattempted", async () => {
    const valid = await insertSubscriber(tdb.db, "valid@example.com", { id: lowId(0) });
    const invalid = await insertSubscriber(tdb.db, "not-an-email", { id: lowId(1) });
    const job = await insertJob(tdb.db, "release-invalid-email");
    await tdb.db.insert(jobRecipients).values([
      { jobId: job.id, subscriberId: valid.id },
      { jobId: job.id, subscriberId: invalid.id },
    ]);
    await tdb.db.insert(deliveries).values([
      { itemKey: "release-invalid-email", subscriberId: valid.id, mode: "as_it_happens" as const, jobId: job.id },
      { itemKey: "release-invalid-email", subscriberId: invalid.id, mode: "as_it_happens" as const, jobId: job.id },
    ]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000006" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.recipients.map((r) => r.email)).toEqual(["valid@example.com"]);

    const [validRow] = await tdb.db.select({ attemptedAt: deliveries.attemptedAt }).from(deliveries).where(and(eq(deliveries.jobId, job.id), eq(deliveries.subscriberId, valid.id)));
    expect(validRow!.attemptedAt).not.toBeNull();
    const [invalidRow] = await tdb.db.select({ attemptedAt: deliveries.attemptedAt }).from(deliveries).where(and(eq(deliveries.jobId, job.id), eq(deliveries.subscriberId, invalid.id)));
    expect(invalidRow!.attemptedAt).toBeNull();
  });

  // claimOneJob used to order strictly by (next_attempt_at, id), so an older digest job
  // was always claimed ahead of a due immediate job created after it. The digest job here is
  // due well before the immediate one (and so would win under the old ordering); priority
  // must still put the immediate job first.
  it("claims a due immediate job before an earlier-due digest job (priority, then next_attempt_at)", async () => {
    const sub = await insertSubscriber(tdb.db, "priority@example.com");

    const digestJob = await insertJob(tdb.db, null, {
      jobKey: "digest:priority-test",
      kind: "digest",
      priority: "digest",
      subject: "Digest",
      html: "<p>digest</p>",
      text: "digest",
      nextAttemptAt: new Date("2000-01-01T00:00:00Z"), // long overdue -- first under the old ordering
    });
    await tdb.db.insert(jobRecipients).values({ jobId: digestJob.id, subscriberId: sub.id });

    const immediateJob = await insertJob(tdb.db, "release-priority-immediate", {
      priority: "immediate",
      subject: "Immediate",
      html: "<p>immediate</p>",
      text: "immediate",
      // Due, but created (and thus next_attempt_at'd) after the digest job above.
    });
    await tdb.db.insert(jobRecipients).values({ jobId: immediateJob.id, subscriberId: sub.id });

    const distribution = dedupingDistribution();
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, batchSize: 1 });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    expect(distribution.calls).toHaveLength(1);
    expect(distribution.calls[0]!.subject).toBe("Immediate");

    const remainingDigest = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, digestJob.id)))[0]!;
    expect(remainingDigest.status).toBe("pending"); // not claimed this round, despite being far more overdue
    const sentImmediate = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, immediateJob.id)))[0]!;
    expect(sentImmediate.status).toBe("sent");
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
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000001" });

    // Small enough that a single recipient's own request already exceeds it, forcing a split
    // all the way down to one recipient per request (4 recipients -> 4 requests).
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, maxChunkBytes: 50 });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

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
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000001" });

    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });
    expect(distribution.send).toHaveBeenCalledTimes(1);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
  });

  // The probe used to size a chunk's split must account for the
  // real per-recipient `{{manageUrl}}`/`{{unsubscribeUrl}}` substitutions every actual send
  // adds -- probing with `{}` for every member (the old behaviour) under-measures a request
  // whose link overhead is a real share of its size, and could let a chunk through whole that,
  // once real links were added at send time, exceeds maxChunkBytes. This matters most for a
  // media job's full release text, where the link overhead can otherwise look negligible by
  // comparison.
  it("sizes the byte-split probe using real per-recipient link lengths, splitting a part the old empty-substitution probe would have kept whole", async () => {
    const emails = [0, 1].map((n) => `probe${n}@example.com`);
    const subs = await Promise.all(emails.map((email, n) => insertSubscriber(tdb.db, email, { id: lowId(n) })));
    const job = await insertJob(tdb.db, "release-probe", { html: "x".repeat(2000), text: "y".repeat(500) });
    await tdb.db.insert(jobRecipients).values(subs.map((s) => ({ jobId: job.id, subscriberId: s.id })));

    const requestSize = (key: string, recipients: { email: string; substitutions: Record<string, string> }[]) =>
      Buffer.byteLength(
        JSON.stringify({
          priority: job.priority,
          idempotencyKey: `${job.id}:${key}`,
          subject: job.subject,
          html: job.html,
          text: job.text,
          headers: { "List-Unsubscribe": "<{{unsubscribeUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
          recipients,
        }),
      );

    const { manageUrlLen, unsubscribeUrlLen } = placeholderLinkLengths(LINKS);
    const placeholderSubs = { manageUrl: "x".repeat(manageUrlLen), unsubscribeUrl: "x".repeat(unsubscribeUrlLen) };
    // The whole (unsplit, chunk_index "0") 2-recipient request, as the probe at n=1 would
    // measure it: once with no substitutions at all (the old bug) and once with real-sized
    // placeholders (the fix).
    const emptySize = requestSize("0", emails.map((email) => ({ email, substitutions: {} })));
    const realSize = requestSize("0", emails.map((email) => ({ email, substitutions: placeholderSubs })));
    // Sanity: the real per-recipient links really do add meaningful weight over `{}`.
    expect(realSize).toBeGreaterThan(emptySize);
    // What a final, split single-recipient part ("0.0"/"0.1") actually weighs once sent, real
    // links included -- splitting barely shrinks the request, since the html/text payload
    // (not the recipient list) dominates its size.
    const onePartSize = Math.max(
      requestSize("0.0", [{ email: emails[0]!, substitutions: placeholderSubs }]),
      requestSize("0.1", [{ email: emails[1]!, substitutions: placeholderSubs }]),
    );

    // A window that (a) the old empty-substitution probe would have judged as fitting whole,
    // (b) the real-link probe must judge as too big (forcing a split), and (c) each resulting
    // single-recipient part still fits within.
    const maxChunkBytes = Math.floor((onePartSize + realSize) / 2);
    expect(emptySize).toBeLessThanOrEqual(maxChunkBytes);
    expect(onePartSize).toBeLessThanOrEqual(maxChunkBytes);
    expect(realSize).toBeGreaterThan(maxChunkBytes);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000001" });
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, maxChunkBytes });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    // Split into one recipient per request -- and critically, every *actual* sent request
    // (now carrying real per-recipient links) still fits within maxChunkBytes.
    expect(distribution.send).toHaveBeenCalledTimes(2);
    for (const call of distribution.send.mock.calls) {
      const sent = call[0] as MessageRequest;
      expect(sent.recipients).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(maxChunkBytes);
    }
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
      .mockImplementationOnce(async () => ({ batchId: "00000000-0000-4000-8000-000000000002" }))
      .mockImplementationOnce(async () => ({ batchId: "00000000-0000-4000-8000-000000000004" }))
      .mockImplementationOnce(async () => {
        throw new DistributionError("HTTP 503", true);
      });

    const now = await dbClock(tdb.db);
    const result1 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, maxChunkBytes: 50, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
    expect(distribution.send).toHaveBeenCalledTimes(3);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0.0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0.1`);
    expect((distribution.send.mock.calls[2]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0.2`);

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterFirst.batchIds).toEqual({ "0.0": "00000000-0000-4000-8000-000000000002", "0.1": "00000000-0000-4000-8000-000000000004" });

    // Between attempts: the subscriber whose sole membership is part 0.1 becomes inactive.
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, subs[1]!.id));

    distribution.send.mockReset();
    distribution.send.mockResolvedValue({ batchId: "00000000-0000-4000-8000-000000000011" });
    const result2 = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, maxChunkBytes: 50, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

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
    expect(afterSecond.batchIds["0.1"]).toBe("00000000-0000-4000-8000-000000000004");
  });
});

describe("distributionClient", () => {
  let server: Server;
  let baseUrl: string;
  let lastAuthHeader: string | undefined;
  let lastRequestBody: MessageRequest | undefined;
  let lastMethod: string | undefined;
  let lastPath: string | undefined;
  let respondStatus: number;
  let respondBody: unknown;

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastAuthHeader = req.headers.authorization;
      lastMethod = req.method;
      lastPath = req.url;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastRequestBody = body ? (JSON.parse(body) as MessageRequest) : undefined;
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

  it("carries NoD's own REPLY_TO (DistributionClientOptions.replyTo) on a request that doesn't set one", async () => {
    respondStatus = 202;
    respondBody = { batchId: "batch-reply-to" };
    const client = distributionClient({ baseUrl, getToken: async () => "t", replyTo: "nod-reply@example.com" });
    await client.send(sampleRequest);
    expect(lastRequestBody?.replyTo).toBe("nod-reply@example.com");
  });

  it("carries no replyTo when neither the request nor DistributionClientOptions.replyTo is set", async () => {
    respondStatus = 202;
    respondBody = { batchId: "batch-no-reply-to" };
    const client = distributionClient({ baseUrl, getToken: async () => "t" });
    await client.send(sampleRequest);
    expect(lastRequestBody?.replyTo).toBeUndefined();
  });

  it("a request's own replyTo wins over the configured REPLY_TO", async () => {
    respondStatus = 202;
    respondBody = { batchId: "batch-own-reply-to" };
    const client = distributionClient({ baseUrl, getToken: async () => "t", replyTo: "nod-reply@example.com" });
    await client.send({ ...sampleRequest, replyTo: "own-reply@example.com" });
    expect(lastRequestBody?.replyTo).toBe("own-reply@example.com");
  });

  // getSettings/setPaused hit Distribution's own settings routes, not /api/messages — same
  // token/error handling as send (callDistribution), just a different path/method/body.
  describe("getSettings / setPaused", () => {
    it("getSettings GETs /api/settings and returns the parsed shape", async () => {
      respondStatus = 200;
      respondBody = { paused: true };
      const client = distributionClient({ baseUrl, getToken: async () => "the-token" });
      expect(await client.getSettings()).toEqual({ paused: true });
      expect(lastMethod).toBe("GET");
      expect(lastPath).toBe("/api/settings");
      expect(lastAuthHeader).toBe("Bearer the-token");
    });

    it("setPaused(true) POSTs /api/settings/pause; setPaused(false) POSTs /api/settings/resume", async () => {
      respondStatus = 200;
      respondBody = { paused: true, changed: true };
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      expect(await client.setPaused(true)).toEqual({ paused: true, changed: true });
      expect(lastMethod).toBe("POST");
      expect(lastPath).toBe("/api/settings/pause");

      respondBody = { paused: false, changed: false };
      expect(await client.setPaused(false)).toEqual({ paused: false, changed: false });
      expect(lastPath).toBe("/api/settings/resume");
    });

    it("maps a 2xx body missing the expected shape to a retryable DistributionError, for both calls", async () => {
      respondStatus = 200;
      respondBody = {};
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      await expect(client.getSettings()).rejects.toMatchObject({ retryable: true, status: 200 });
      await expect(client.setPaused(true)).rejects.toMatchObject({ retryable: true, status: 200 });
    });

    it("maps a 503 from Distribution's settings routes to a retryable DistributionError", async () => {
      respondStatus = 503;
      respondBody = "service unavailable";
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      await expect(client.getSettings()).rejects.toMatchObject({ retryable: true, status: 503 });
      await expect(client.setPaused(true)).rejects.toMatchObject({ retryable: true, status: 503 });
    });

    it("maps a 403 (missing Distribution.Operate) to a retryable DistributionError and logs loudly", async () => {
      respondStatus = 403;
      respondBody = { error: "forbidden" };
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.setPaused(true)).rejects.toMatchObject({ retryable: true, status: 403 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Distribution rejected our credentials (401/403)"));
      errorSpy.mockRestore();
    });
  });

  // uploadBounce/bounceStats hit Distribution's own bounce routes -- same token/error handling
  // as everything else (callDistribution), just a different path/method/body/response shape.
  describe("uploadBounce / bounceStats", () => {
    it("uploadBounce POSTs /api/bounces/inbox with the raw message and returns the id", async () => {
      respondStatus = 201;
      respondBody = { id: "bounce-inbox-1" };
      const client = distributionClient({ baseUrl, getToken: async () => "the-token" });
      expect(await client.uploadBounce("Subject: Undeliverable: x\r\n\r\nbody")).toEqual({ id: "bounce-inbox-1" });
      expect(lastMethod).toBe("POST");
      expect(lastPath).toBe("/api/bounces/inbox");
      expect(lastAuthHeader).toBe("Bearer the-token");
      expect(lastRequestBody).toEqual({ raw: "Subject: Undeliverable: x\r\n\r\nbody" });
    });

    it("uploadBounce maps a 404 (not the fake inbox) to a non-retryable DistributionError", async () => {
      respondStatus = 404;
      respondBody = { error: "not found" };
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      await expect(client.uploadBounce("x")).rejects.toMatchObject({ retryable: false, status: 404 });
    });

    it("uploadBounce maps a 2xx body missing id to a retryable DistributionError", async () => {
      respondStatus = 201;
      respondBody = {};
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      await expect(client.uploadBounce("x")).rejects.toMatchObject({ retryable: true, status: 201 });
    });

    it("bounceStats GETs /api/bounces/stats with since as a query param and returns the parsed counts", async () => {
      respondStatus = 200;
      respondBody = { unmatched: 3, ignored: 5 };
      const client = distributionClient({ baseUrl, getToken: async () => "the-token" });
      expect(await client.bounceStats("2026-10-05T08:00:00.000Z")).toEqual({ unmatched: 3, ignored: 5 });
      expect(lastMethod).toBe("GET");
      expect(lastPath).toBe(`/api/bounces/stats?since=${encodeURIComponent("2026-10-05T08:00:00.000Z")}`);
      expect(lastAuthHeader).toBe("Bearer the-token");
    });

    it("bounceStats maps a 2xx body missing unmatched/ignored to a retryable DistributionError", async () => {
      respondStatus = 200;
      respondBody = { unmatched: 1 };
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      await expect(client.bounceStats("2026-10-05T08:00:00.000Z")).rejects.toMatchObject({ retryable: true, status: 200 });
    });

    it("maps a 503 from either bounce route to a retryable DistributionError", async () => {
      respondStatus = 503;
      respondBody = "service unavailable";
      const client = distributionClient({ baseUrl, getToken: async () => "t" });
      await expect(client.uploadBounce("x")).rejects.toMatchObject({ retryable: true, status: 503 });
      await expect(client.bounceStats("2026-10-05T08:00:00.000Z")).rejects.toMatchObject({ retryable: true, status: 503 });
    });
  });
});
