// P2-R22 D1 / P2-R27 item 1: the four background workers must run entirely on the database's
// clock. This runs each of them, with no `now` test hook, in a process whose wall clock is
// 10 minutes ahead of — or behind — the database's (global Date replaced by an offset
// subclass; performance.now untouched), against real test databases, and checks every
// time-dependent outcome against the database's own now():
//   - the claim's lock is lockMs from the DB's now() (not from the skewed JS clock),
//   - a retry's backoff is measured from the DB's now(),
//   - another replica with a correct clock can't re-claim the row mid-work,
//   - a short age backstop isn't tripped by the skew,
//   - NRMS publishes exactly what is due by the DB's clock.
// Any claim/stamp that fell back to the JS clock fails here (revert-checked in the P2-R27
// report for the dispatcher, sender and NoD claims and the NRMS due check).
import type { Transporter } from "nodemailer";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbClock, type TestDatabase } from "@gcpe/db-kit";
import { backoffMs as dispatchBackoffMs, dispatchOnce, enqueueEvent, type SubscriberConfig } from "@gcpe/events";

import { publishDue } from "../apps/nrms/src/publisher";
import { createNrmsTestDb, createScheduledRelease } from "../apps/nrms/test/helpers";

import { createBatch } from "../apps/distribution/src/messages";
import { defaultSendLockMs, sendDue } from "../apps/distribution/src/sender";
import { createDistributionTestDb, sampleMessageRequest } from "../apps/distribution/test/helpers";

import { DistributionError, type DistributionClient } from "../apps/nod/src/distribution-client";
import { sendDueJobs } from "../apps/nod/src/send-jobs";
import { createNodTestDb } from "../apps/nod/test/helpers";

const RealDate = Date;
let skewMs = 0;
/** `new Date()` / `Date.now()` read the real clock plus `skewMs`; `new Date(x)` is untouched. */
class SkewedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + skewMs);
    else super(...(args as [number]));
  }
  static override now(): number {
    return RealDate.now() + skewMs;
  }
}
/** Runs `fn` as a replica whose clock is correct (used for the "another replica" probe). */
async function unskewed<T>(fn: () => Promise<T>): Promise<T> {
  const saved = skewMs;
  skewMs = 0;
  try {
    return await fn();
  } finally {
    skewMs = saved;
  }
}

const TEN_MINUTES = 10 * 60_000;
const SHORT_MAX_AGE_MS = 5 * 60_000; // well under the 10-minute skew: a JS-clock age would trip it
const TOLERANCE_MS = 5_000;

/** Milliseconds from the DB's now() to `expr` (a timestamptz column) in the row `where` picks. */
async function msFromDbNow(tdb: TestDatabase, table: string, column: string, where: string, params: unknown[]): Promise<number> {
  const { rows } = await tdb.pool.query<{ ms: number }>(`SELECT (extract(epoch from (${column} - now())) * 1000)::float8 AS ms FROM ${table} WHERE ${where}`, params);
  return Number(rows[0]!.ms);
}
function expectAbout(actualMs: number, expectedMs: number): void {
  expect(actualMs).toBeLessThanOrEqual(expectedMs + 1);
  expect(actualMs).toBeGreaterThan(expectedMs - TOLERANCE_MS);
}

describe.each([
  ["10 minutes ahead of", TEN_MINUTES],
  ["10 minutes behind", -TEN_MINUTES],
])("workers in a process whose clock is %s the database's", (_label, offset) => {
  let nrmsDb: TestDatabase;
  let distributionDb: TestDatabase;
  let nodDb: TestDatabase;

  beforeAll(async () => {
    [nrmsDb, distributionDb, nodDb] = await Promise.all([createNrmsTestDb(), createDistributionTestDb(), createNodTestDb()]);
  });
  afterAll(async () => {
    await Promise.all([nrmsDb?.drop(), distributionDb?.drop(), nodDb?.drop()]);
  });
  beforeEach(() => {
    skewMs = offset;
    globalThis.Date = SkewedDate as DateConstructor;
    return () => {
      globalThis.Date = RealDate;
      skewMs = 0;
    };
  });

  it("dispatcher: lock and retry backoff come from the DB clock, no re-claim by a correct-clock replica, age backstop not tripped", async () => {
    const subs: SubscriberConfig[] = [{ name: "target", url: "http://skew.invalid/events", secret: "k", types: ["*"] }];
    const env = await enqueueEvent(nrmsDb.db, { type: "org.deactivated", source: "core", aggregateId: `org:skew${offset}`, data: { key: "s" } }, subs);
    const lockMs = 50 * 10_000 + 30_000; // defaultLockMs at the defaults
    let lockFromDbNow: number | undefined;
    let replica: unknown;
    const result = await dispatchOnce({
      db: nrmsDb.db,
      subscribers: subs,
      maxAgeMs: SHORT_MAX_AGE_MS,
      fetchImpl: async () => {
        lockFromDbNow = await msFromDbNow(nrmsDb, "outbox_deliveries", "locked_until", "event_id = $1", [env.id]);
        replica = await unskewed(() => dispatchOnce({ db: nrmsDb.db, subscribers: subs, fetchImpl: async () => new Response(null, { status: 200 }) }));
        return new Response(null, { status: 503 });
      },
    });
    expect(result).toEqual({ delivered: 0, retried: 1, dead: 0 });
    expectAbout(lockFromDbNow!, lockMs);
    expect(replica).toEqual({ delivered: 0, retried: 0, dead: 0 });
    expectAbout(await msFromDbNow(nrmsDb, "outbox_deliveries", "next_attempt_at", "event_id = $1", [env.id]), dispatchBackoffMs(1));
  });

  it("sender: lock and retry backoff come from the DB clock, no re-claim by a correct-clock replica, age backstop not tripped", async () => {
    await distributionDb.pool.query("TRUNCATE TABLE messages, batches");
    await createBatch(distributionDb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "skew@example.com", substitutions: {} }] }, []);
    const lockMs = defaultSendLockMs({ batchSize: 50, perMessageMs: 50_000, verifyTimeoutMs: 10_000 });
    let lockFromDbNow: number | undefined;
    let replica: unknown;
    const transport = {
      sendMail: async () => {
        lockFromDbNow = await msFromDbNow(distributionDb, "messages", "locked_until", "email = $1", ["skew@example.com"]);
        replica = await unskewed(() => sendDue({ db: distributionDb.db, transport: { sendMail: async () => ({}) } as unknown as Transporter, from: "news@example.com", redirectTo: [] }));
        throw new Error("transient hiccup");
      },
    } as unknown as Transporter;
    const result = await sendDue({ db: distributionDb.db, transport, from: "news@example.com", redirectTo: [], maxMessageAgeMs: SHORT_MAX_AGE_MS });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
    expectAbout(lockFromDbNow!, lockMs);
    expect(replica).toEqual({ sent: 0, retried: 0, failed: 0 });
    expectAbout(await msFromDbNow(distributionDb, "messages", "next_attempt_at", "email = $1", ["skew@example.com"]), 30_000 * 2 ** 1);
  });

  it("NoD send-jobs: lock and retry backoff come from the DB clock, no re-claim by a correct-clock replica, age backstop not tripped", async () => {
    await nodDb.pool.query("TRUNCATE TABLE send_jobs, job_recipients, subscribers CASCADE");
    const { rows: subRows } = await nodDb.pool.query<{ id: string }>(
      "INSERT INTO subscribers (email, verified_at, status) VALUES ('skew@example.com', now(), 'active') RETURNING id",
    );
    const { rows: jobRows } = await nodDb.pool.query<{ id: string }>(
      "INSERT INTO send_jobs (job_key, item_key, kind, subject, html, text) VALUES ('as_it_happens:release-skew', 'release-skew', 'as_it_happens', 's', '<p>h</p>', 't') RETURNING id",
    );
    await nodDb.pool.query("INSERT INTO job_recipients (job_id, subscriber_id) VALUES ($1, $2)", [jobRows[0]!.id, subRows[0]!.id]);
    const jobId = jobRows[0]!.id;
    const lockMs = 1 * 30_000 + 30_000 + 30_000; // one chunk, plus getToken, plus the margin
    const links = { pageUrl: "https://news.example/manage", subscribeApiUrl: "https://news.example/api/Subscribe", linkSecret: "x".repeat(32) };
    let lockFromDbNow: number | undefined;
    let replica: unknown;
    const distribution: DistributionClient = {
      send: async () => {
        lockFromDbNow = await msFromDbNow(nodDb, "send_jobs", "locked_until", "id = $1", [jobId]);
        replica = await unskewed(() => sendDueJobs({ db: nodDb.db, distribution: { send: async () => ({ batchId: "x" }) }, links }));
        throw new DistributionError("HTTP 503", true);
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await sendDueJobs({ db: nodDb.db, distribution, links, maxAgeMs: SHORT_MAX_AGE_MS });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0, cancelled: 0, paused: false });
    } finally {
      warnSpy.mockRestore();
    }
    expectAbout(lockFromDbNow!, lockMs);
    expect(replica).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0, paused: false });
    expectAbout(await msFromDbNow(nodDb, "send_jobs", "next_attempt_at", "id = $1", [jobId]), dispatchBackoffMs(1));
  });

  it("NRMS: publishes exactly the releases due by the DB clock, stamped with the DB's now()", async () => {
    await nrmsDb.pool.query("TRUNCATE news_releases, release_log, release_publications, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    const dbNow = await unskewed(() => dbClock(nrmsDb.db));
    const due = await createScheduledRelease(nrmsDb.db, {}, new RealDate(dbNow.getTime() - 60_000)); // due a minute ago
    await createScheduledRelease(nrmsDb.db, {}, new RealDate(dbNow.getTime() + 5 * 60_000)); // due in 5 minutes

    expect(await publishDue({ db: nrmsDb.db, subscribers: [] })).toEqual({ published: [due.key], updated: [], unpublished: [], failed: [], deferred: [] });
    // The publisher stamps updated_at with the DB's now(); released_at is the scheduled publish_at.
    expectAbout(await msFromDbNow(nrmsDb, "news_releases", "updated_at", "id = $1", [due.id]), 0);
    expectAbout(await msFromDbNow(nrmsDb, "news_releases", "released_at", "id = $1", [due.id]), -60_000);
  });
});
