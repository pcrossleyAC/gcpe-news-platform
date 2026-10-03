import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createTestDatabase } from "@gcpe/db-kit";
import { DistributionError, distributionClient, type DistributionClient, type MessageRequest } from "./distribution-client";
import { deliveries, sendJobs, subscribers } from "./db/schema";
import { MAX_RECIPIENTS_PER_CHUNK, sendDueJobs } from "./send-jobs";

const nodMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
const MANAGE_URL = "https://news.example/subscribe/manage";

async function insertSubscriber(db: TestDatabase["db"], email: string, verified = true): Promise<{ id: string; manageToken: string }> {
  const [row] = await db
    .insert(subscribers)
    .values({ email, manageToken: randomUUID(), verifiedAt: verified ? new Date() : null })
    .returning({ id: subscribers.id, manageToken: subscribers.manageToken });
  return row!;
}

async function insertJob(db: TestDatabase["db"], releaseKey: string, overrides: Partial<typeof sendJobs.$inferInsert> = {}) {
  const [row] = await db
    .insert(sendJobs)
    .values({
      releaseKey,
      subject: "Clinics open",
      html: "<p>hi</p>",
      text: "hi",
      // Explicit, JS-clock-derived "already due" rather than the column's defaultNow():
      // comparing that default (stamped by Postgres's own clock) against sendDueJobs's
      // JS-side `now()` moments later is exposed to clock skew between the test process and
      // the database server, which is a real, measurable source of flakiness in this
      // environment.
      nextAttemptAt: new Date(Date.now() - 1000),
      ...overrides,
    })
    .returning();
  return row!;
}

function stubDistribution(): DistributionClient & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn> };
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
    await tdb.pool.query("TRUNCATE TABLE send_jobs, deliveries, subscribers CASCADE");
  });

  it("sends one request with every verified recipient, per-recipient manage links and list-unsubscribe headers", async () => {
    const alex = await insertSubscriber(tdb.db, "alex@example.com");
    const sam = await insertSubscriber(tdb.db, "sam@example.com");
    const job = await insertJob(tdb.db, "release-1");
    await tdb.db.insert(deliveries).values([
      { releaseKey: "release-1", subscriberId: alex.id },
      { releaseKey: "release-1", subscriberId: sam.id },
    ]);

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "batch-1" });

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.idempotencyKey).toBe(`${job.id}:0`);
    expect(req.headers).toEqual({ "List-Unsubscribe": "<{{manageUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(req.recipients).toHaveLength(2);
    const byEmail = new Map(req.recipients.map((r) => [r.email, r.substitutions.manageUrl]));
    expect(byEmail.get("alex@example.com")).toBe(`${MANAGE_URL}?token=${encodeURIComponent(alex.manageToken)}`);
    expect(byEmail.get("sam@example.com")).toBe(`${MANAGE_URL}?token=${encodeURIComponent(sam.manageToken)}`);

    const updated = (await tdb.db.select().from(sendJobs))[0]!;
    expect(updated.status).toBe("sent");
    expect(updated.batchIds).toEqual(["batch-1"]);
    expect(updated.lockedUntil).toBeNull();
  });

  it("only sends to verified subscribers", async () => {
    const verified = await insertSubscriber(tdb.db, "verified@example.com", true);
    await insertSubscriber(tdb.db, "unverified@example.com", false);
    await insertJob(tdb.db, "release-2");
    await tdb.db.insert(deliveries).values([{ releaseKey: "release-2", subscriberId: verified.id }]);
    // An unverified subscriber was never added to `deliveries` by the Task 9 handler in the
    // first place (createAsItHappensHandler filters on verifiedAt), but even if a row existed,
    // the recipient query itself re-checks verifiedAt — belt and suspenders.

    const distribution = stubDistribution();
    distribution.send.mockResolvedValue({ batchId: "batch-x" });
    await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });

    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.recipients.map((r) => r.email)).toEqual(["verified@example.com"]);
  });

  it("retries a retryable failure with backoff, then succeeds using the same idempotency key", async () => {
    const sub = await insertSubscriber(tdb.db, "retry@example.com");
    const job = await insertJob(tdb.db, "release-3");
    await tdb.db.insert(deliveries).values([{ releaseKey: "release-3", subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValueOnce(new DistributionError("HTTP 503", true));

    // No `now` override on this first call: the job's next_attempt_at default was stamped by
    // Postgres's own clock a moment ago, and comparing it against a JS-side `Date.now()`
    // captured just before this call risks a flaky off-by-a-few-ms race against clock skew
    // between the test process and the database server.
    const before = Date.now();
    const result1 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0 });

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(afterFirst.lockedUntil).toBeNull();

    distribution.send.mockResolvedValueOnce({ batchId: "batch-2" });
    const result2 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, now: () => afterFirst.nextAttemptAt });
    expect(result2).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(distribution.send).toHaveBeenCalledTimes(2);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);

    const afterSecond = (await tdb.db.select().from(sendJobs))[0]!;
    expect(afterSecond.status).toBe("sent");
    expect(afterSecond.batchIds).toEqual(["batch-2"]);
  });

  it("fails immediately on a non-retryable error", async () => {
    const sub = await insertSubscriber(tdb.db, "bad@example.com");
    await insertJob(tdb.db, "release-4");
    await tdb.db.insert(deliveries).values([{ releaseKey: "release-4", subscriberId: sub.id }]);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new DistributionError("HTTP 400: invalid subject", false));

    const result = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });

    const row = (await tdb.db.select().from(sendJobs))[0]!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/HTTP 400/);
  });

  it("fails a retryable error once the job is older than maxAgeMs", async () => {
    const sub = await insertSubscriber(tdb.db, "old@example.com");
    await insertJob(tdb.db, "release-5");
    await tdb.db.insert(deliveries).values([{ releaseKey: "release-5", subscriberId: sub.id }]);

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

  it("two concurrent runs send each due job exactly once", async () => {
    const subA = await insertSubscriber(tdb.db, "a@example.com");
    const subB = await insertSubscriber(tdb.db, "b@example.com");
    await insertJob(tdb.db, "release-6a");
    await insertJob(tdb.db, "release-6b");
    await tdb.db.insert(deliveries).values([
      { releaseKey: "release-6a", subscriberId: subA.id },
      { releaseKey: "release-6b", subscriberId: subB.id },
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
    const subs = await Promise.all(Array.from({ length: 5 }, (_, i) => insertSubscriber(tdb.db, `r${i}@example.com`)));
    const job = await insertJob(tdb.db, "release-7");
    await tdb.db.insert(deliveries).values(subs.map((s) => ({ releaseKey: "release-7", subscriberId: s.id })));

    const distribution = stubDistribution();
    // chunkSize 2 over 5 recipients → chunks :0 (2), :1 (2), :2 (1). First attempt: :0 ok, :1
    // fails retryably, :2 never reached.
    distribution.send.mockImplementationOnce(async () => ({ batchId: "b0" })).mockImplementationOnce(async () => {
      throw new DistributionError("HTTP 503", true);
    });

    const now = new Date();
    const result1 = await sendDueJobs({ db: tdb.db, distribution, manageUrl: MANAGE_URL, chunkSize: 2, now: () => now });
    expect(result1).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(distribution.send).toHaveBeenCalledTimes(2);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:0`);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey).toBe(`${job.id}:1`);

    const afterFirst = (await tdb.db.select().from(sendJobs))[0]!;

    // Retry: resends ALL three chunks, including :0 which already succeeded.
    distribution.send.mockReset();
    distribution.send.mockResolvedValueOnce({ batchId: "b0" }).mockResolvedValueOnce({ batchId: "b1" }).mockResolvedValueOnce({ batchId: "b2" });
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
    expect(afterSecond.batchIds).toEqual(["b0", "b1", "b2"]);
  });
});

describe("MAX_RECIPIENTS_PER_CHUNK", () => {
  it("is Distribution's own per-request recipient limit", () => {
    expect(MAX_RECIPIENTS_PER_CHUNK).toBe(20_000);
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

  it("maps a network error to a retryable DistributionError", async () => {
    const client = distributionClient({ baseUrl: "http://127.0.0.1:1", getToken: async () => "t" });
    await expect(client.send(sampleRequest)).rejects.toMatchObject({ retryable: true });
  });
});
