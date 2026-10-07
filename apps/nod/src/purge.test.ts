import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, waitForLockWaiter } from "../test/helpers";
import {
  deliveries, jobRecipients, mediaOptOuts, nodSettings, operationsLog, sendJobs, subscriberHistory, subscriberLinks, subscribers, subscriptions,
  type SubscriberStatus,
} from "./db/schema";
import { lockAddress } from "./locks";
import { getPurgeStatus, previewPurge, purgeBatch, purgeSelection, runPurgeIfDue, setPurgeEnabled } from "./purge";

const TZ = "America/Vancouver";
const DAY = 24 * 3_600_000;
/** 04:00 BC on 2026-11-20, after BC moved to permanent UTC−7: 03:00 BC is 10:00Z. */
const NOW = new Date("2026-11-20T11:00:00Z");
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY);

describe("retention purge", () => {
  let tdb: TestDatabase;
  let clock = NOW;
  const now = () => clock;
  let n = 0;

  async function subscriber(status: SubscriberStatus, opts: { createdAt?: Date; endedAt?: Date | null } = {}): Promise<string> {
    n += 1;
    const [s] = await tdb.db
      .insert(subscribers)
      .values({ email: `p${n}@example.test`, status, createdAt: opts.createdAt ?? ago(400), endedAt: opts.endedAt ?? null })
      .returning({ id: subscribers.id });
    return s!.id;
  }
  async function link(origin: "request" | "send", opts: { createdAt: Date; expiresAt?: Date; usedAt?: Date | null; subscriberId?: string | null }): Promise<string> {
    const [l] = await tdb.db
      .insert(subscriberLinks)
      .values({
        tokenHash: randomBytes(16).toString("hex"),
        purpose: origin === "send" ? "manage" : "verify",
        email: "link@example.test",
        origin,
        createdAt: opts.createdAt,
        expiresAt: opts.expiresAt ?? new Date(opts.createdAt.getTime() + DAY),
        usedAt: opts.usedAt ?? null,
        subscriberId: opts.subscriberId ?? null,
      })
      .returning({ id: subscriberLinks.id });
    return l!.id;
  }
  const exists = async (id: string) => (await tdb.db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.id, id))).length === 1;
  const linkExists = async (id: string) => (await tdb.db.select({ id: subscriberLinks.id }).from(subscriberLinks).where(eq(subscriberLinks.id, id))).length === 1;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    clock = NOW;
    await tdb.db.execute(sql`DELETE FROM subscriber_links; DELETE FROM job_recipients; DELETE FROM send_jobs; DELETE FROM deliveries; DELETE FROM subscriber_history; DELETE FROM subscriptions; DELETE FROM subscribers; DELETE FROM media_opt_outs; DELETE FROM operations_log;`);
    await tdb.db.update(nodSettings).set({ purgeEnabled: false, purgeDoneCutoff: null, purgeLease: null, purgeLeaseUntil: null, purgeResult: null }).where(eq(nodSettings.id, 1));
  });

  it("the preview counts exactly what the purge removes, at each boundary", async () => {
    const goneUnconfirmed = await subscriber("pending", { createdAt: ago(11) });
    const keptUnconfirmed9 = await subscriber("pending", { createdAt: ago(9) });
    const keptUnconfirmed10 = await subscriber("pending", { createdAt: ago(10) });
    const goneEnded = await subscriber("deleted", { endedAt: ago(91) });
    const keptEnded89 = await subscriber("deleted", { endedAt: ago(89) });
    const keptEnded90 = await subscriber("deleted", { endedAt: ago(90) });
    const keptDeletedNoEnd = await subscriber("deleted");
    const keptActive = await subscriber("active");
    const keptDisabled = await subscriber("disabled");
    const goneUnused = await link("request", { createdAt: ago(11) });
    const keptUsed = await link("request", { createdAt: ago(11), usedAt: ago(10.5) });
    const keptRecent = await link("request", { createdAt: ago(9) });
    const goneSend = await link("send", { createdAt: ago(12), expiresAt: ago(11) });
    const keptSend = await link("send", { createdAt: ago(10), expiresAt: ago(9) });

    const preview = await previewPurge(tdb.db, now);
    expect(preview).toEqual({ pendingSubscribers: 1, endedSubscribers: 1, unusedLinks: 1, expiredSendLinks: 1 });

    const run = await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    expect(run).toEqual({ counts: preview, finished: true });
    expect(await previewPurge(tdb.db, now)).toEqual({ pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 });

    for (const id of [goneUnconfirmed, goneEnded]) expect(await exists(id)).toBe(false);
    for (const id of [keptUnconfirmed9, keptUnconfirmed10, keptEnded89, keptEnded90, keptDeletedNoEnd, keptActive, keptDisabled]) expect(await exists(id)).toBe(true);
    for (const id of [goneUnused, goneSend]) expect(await linkExists(id)).toBe(false);
    for (const id of [keptUsed, keptRecent, keptSend]) expect(await linkExists(id)).toBe(true);
  });

  it("while off, only expired send links are cleared", async () => {
    const ended = await subscriber("deleted", { endedAt: ago(200) });
    const unused = await link("request", { createdAt: ago(30) });
    await link("send", { createdAt: ago(30), expiresAt: ago(29) });
    const run = await purgeBatch(tdb.db, { enabled: false, deadline: Infinity, now });
    expect(run).toEqual({ counts: { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 1 }, finished: true });
    expect(await exists(ended)).toBe(true);
    expect(await linkExists(unused)).toBe(true);
  });

  it("a purged subscriber's deliveries, history, subscriptions, links and job places go with them", async () => {
    const id = await subscriber("deleted", { endedAt: ago(120) });
    const [job] = await tdb.db.insert(sendJobs).values({ jobKey: `test:${randomUUID()}` }).returning({ id: sendJobs.id });
    await tdb.db.insert(jobRecipients).values({ jobId: job!.id, subscriberId: id });
    await tdb.db.insert(deliveries).values({ itemKey: "2026FIN0001-000001", subscriberId: id, mode: "as_it_happens" });
    await tdb.db.insert(subscriberHistory).values({ subscriberId: id, actor: "self", action: "unsubscribed" });
    await tdb.db.insert(subscriptions).values({ subscriberId: id, listKey: "ministries:finance" });
    await link("request", { createdAt: ago(130), usedAt: ago(130), subscriberId: id });
    await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    const left = await tdb.db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM deliveries WHERE subscriber_id = ${id}) + (SELECT count(*) FROM subscriber_history WHERE subscriber_id = ${id})
           + (SELECT count(*) FROM subscriptions WHERE subscriber_id = ${id}) + (SELECT count(*) FROM subscriber_links WHERE subscriber_id = ${id})
           + (SELECT count(*) FROM job_recipients WHERE subscriber_id = ${id}) AS n`);
    expect(Number(left.rows[0]!.n)).toBe(0);
  });

  it("a purged media-list opt-out is kept as a hash", async () => {
    const id = await subscriber("deleted", { endedAt: ago(100) });
    await tdb.db.insert(subscriberHistory).values({ subscriberId: id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:budget", at: ago(100) });
    await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    const kept = await tdb.db.select().from(mediaOptOuts);
    expect(kept).toEqual([{ emailHash: expect.stringMatching(/^[0-9a-f]{64}$/), listKey: "media-distribution-lists:budget", optedOutAt: ago(100) }]);
  });

  it("someone who comes back after selection is kept", async () => {
    const id = await subscriber("deleted", { endedAt: ago(100) });
    const [row] = await tdb.db.select({ email: subscribers.email }).from(subscribers).where(eq(subscribers.id, id));
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const released = new Promise<void>((r) => (release = r));
    const holder = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, row!.email);
      locked();
      await released;
      await tx.update(subscribers).set({ status: "active", endedAt: null }).where(eq(subscribers.id, id));
    });
    await isLocked;
    const purge = purgeBatch(tdb.db, { enabled: true, deadline: Infinity, now });
    await waitForLockWaiter(tdb.db);
    release();
    await holder;
    expect((await purge).counts.endedSubscribers).toBe(0);
    expect(await exists(id)).toBe(true);
  });

  it("a backlog runs in bounded calls, each subscriber in its own transaction, and adds up to the preview", async () => {
    for (let i = 0; i < 25; i++) await subscriber("deleted", { endedAt: ago(100 + i) });
    const preview = await previewPurge(tdb.db, now);
    const calls = [];
    for (let i = 0; i < 3; i++) calls.push(await purgeBatch(tdb.db, { enabled: true, deadline: Infinity, maxSubscribers: 10, now }));
    expect(calls.map((c) => [c.counts.endedSubscribers, c.finished])).toEqual([[10, false], [10, false], [5, true]]);
    expect(calls.reduce((t, c) => t + c.counts.endedSubscribers, 0)).toBe(preview.endedSubscribers);
  });

  it("cascades and sweeps read through indexes", async () => {
    await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const plan = async (q: SQL) => (await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${q}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
      const sel = purgeSelection(now);
      expect(await plan(sql`SELECT 1 FROM job_recipients WHERE subscriber_id = ${randomUUID()}::uuid`)).toContain("job_recipients_subscriber_idx");
      expect(await plan(sql`SELECT 1 FROM subscriber_links WHERE subscriber_id = ${randomUUID()}::uuid`)).toContain("subscriber_links_subscriber_idx");
      expect(await plan(sql`SELECT id FROM subscriber_links WHERE ${sel.expiredSendLinks}`)).toContain("subscriber_links_send_expiry_idx");
      expect(await plan(sql`SELECT id FROM subscriber_links WHERE ${sel.unusedLinks}`)).toContain("subscriber_links_request_unused_idx");
    });
  });

  describe("the nightly run", () => {
    const yesterday0300 = new Date("2026-11-19T10:00:00Z");
    const today0300 = new Date("2026-11-20T10:00:00Z");

    it("not before 03:00 BC; once a night", async () => {
      await tdb.db.update(nodSettings).set({ purgeDoneCutoff: yesterday0300 }).where(eq(nodSettings.id, 1));
      clock = new Date(today0300.getTime() - 60_000);
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(false);
      clock = today0300;
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(true);
      clock = new Date(today0300.getTime() + 3_600_000);
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(false);
    });

    it("an unfinished night continues on the next call, adds up its counts, and logs once at the end", async () => {
      await setPurgeEnabled(tdb.db, true, "Avery Admin", now);
      for (let i = 0; i < 3; i++) await subscriber("deleted", { endedAt: ago(100) });
      const first = await runPurgeIfDue(tdb.db, TZ, { now, maxSubscribers: 2 });
      expect(first.result).toMatchObject({ cutoff: today0300.toISOString(), finished: false, counts: { endedSubscribers: 2 } });
      const second = await runPurgeIfDue(tdb.db, TZ, { now, maxSubscribers: 2 });
      expect(second.result).toMatchObject({ finished: true, counts: { endedSubscribers: 3 } });
      expect((await runPurgeIfDue(tdb.db, TZ, { now })).ran).toBe(false);
      const log = await tdb.db.select().from(operationsLog).where(eq(operationsLog.action, "purge-ran"));
      expect(log).toHaveLength(1);
      expect(log[0]!.detail).toContain("ended subscribers 3");
      expect(JSON.stringify(log)).not.toContain("@");
    });

    it("enabling logs what it would remove now; a repeat changes nothing", async () => {
      await subscriber("pending", { createdAt: ago(20) });
      expect(await setPurgeEnabled(tdb.db, true, "Avery Admin", now)).toEqual({ changed: true });
      expect(await setPurgeEnabled(tdb.db, true, "Avery Admin", now)).toEqual({ changed: false });
      expect(await setPurgeEnabled(tdb.db, false, "Avery Admin", now)).toEqual({ changed: true });
      const log = await tdb.db.select().from(operationsLog).orderBy(operationsLog.at);
      expect(log.map((l) => l.action)).toEqual(["purge-enabled", "purge-disabled"]);
      expect(log[0]!.detail).toContain("unconfirmed subscribers 1");
    });

    it("status: the switch, the preview, the last run and the next 03:00", async () => {
      await runPurgeIfDue(tdb.db, TZ, { now });
      expect(await getPurgeStatus(tdb.db, TZ, now)).toEqual({
        enabled: false,
        preview: { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 },
        lastRun: { cutoff: today0300.toISOString(), counts: { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 }, finished: true, enabled: false },
        nextRunAt: "2026-11-21T10:00:00.000Z",
      });
    });
  });
});
