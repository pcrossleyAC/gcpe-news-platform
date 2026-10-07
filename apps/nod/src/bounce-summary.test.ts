import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { BOUNCE_SUMMARY_HOUR, runBounceSummaryIfDue, startBounceSummaryLoop } from "./bounce-summary";
import { BOUNCE_ACTOR } from "./bounces";
import { dailyCutoff } from "./digest";
import type { DistributionClient, MessageRequest } from "./distribution-client";
import { deliveries, nodSettings, subscriberHistory, subscribers, subscriptions } from "./db/schema";

const TZ = "America/Vancouver";
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

function stubDistribution(): DistributionClient & { send: ReturnType<typeof vi.fn>; bounceStats: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({ batchId: "batch-summary" }),
    bounceStats: vi.fn().mockResolvedValue({ unmatched: 0, ignored: 0 }),
  } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn>; bounceStats: ReturnType<typeof vi.fn> };
}

async function insertSubscriber(db: TestDatabase["db"], email: string): Promise<string> {
  const [row] = await db.insert(subscribers).values({ email, status: "active", verifiedAt: new Date() }).returning({ id: subscribers.id });
  return row!.id;
}

async function insertHardBounceDelivery(db: TestDatabase["db"], subscriberId: string, opts: { at: Date; status: string }): Promise<void> {
  await db.insert(deliveries).values({
    subscriberId,
    itemKey: `item-${randomUUID().slice(0, 8)}`,
    mode: "as_it_happens",
    attemptedAt: opts.at,
    hardBouncedAt: opts.at,
    bounceStatus: opts.status,
  });
}

async function insertHistory(db: TestDatabase["db"], subscriberId: string, action: "bounce-recorded" | "bounce-disabled" | "bounce-flagged", detail: string, at: Date): Promise<void> {
  await db.insert(subscriberHistory).values({ subscriberId, actor: BOUNCE_ACTOR, action, detail, at });
}

async function makeMediaMember(db: TestDatabase["db"], subscriberId: string): Promise<void> {
  await db.insert(subscriptions).values({ subscriberId, listKey: "media-distribution-lists:budget" });
}

describe("BOUNCE_SUMMARY_HOUR", () => {
  it("is 8", () => {
    expect(BOUNCE_SUMMARY_HOUR).toBe(8);
  });
});

describe("runBounceSummaryIfDue", () => {
  let tdb: TestDatabase;
  let cutoff: Date;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE subscriber_history, deliveries, subscriptions, subscribers CASCADE");
    await tdb.db.update(nodSettings).set({ bounceSummaryAt: null }).where(eq(nodSettings.id, 1));
    // Same reasoning as digest.test.ts: only relative order to `cutoff` matters here, never
    // its exact value, so the real clock is fine.
    cutoff = dailyCutoff(new Date(), TZ, BOUNCE_SUMMARY_HOUR);
  });

  async function setLastSummaryAt(d: Date | null): Promise<void> {
    await tdb.db.update(nodSettings).set({ bounceSummaryAt: d }).where(eq(nodSettings.id, 1));
  }

  it("no recipient configured: never sends, never touches the database", async () => {
    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, null);
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();
    expect(distribution.bounceStats).not.toHaveBeenCalled();
  });

  it("not before 08:00 BC time: already summarised at this cutoff, so a later check this same day does nothing more", async () => {
    await setLastSummaryAt(cutoff);
    const sub = await insertSubscriber(tdb.db, "late@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at: new Date(), status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", new Date());

    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();
  });

  it("once per day: a second due check right after a successful send does nothing more", async () => {
    await setLastSummaryAt(new Date(cutoff.getTime() - DAY_MS));
    const sub = await insertSubscriber(tdb.db, "oncea@example.test");
    const at = new Date(cutoff.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    const first = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(first).toEqual({ sent: true, lines: 1 });
    expect(distribution.send).toHaveBeenCalledTimes(1);

    const second = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(second).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).toHaveBeenCalledTimes(1);
  });

  it("nothing to report: no email, and bounce_summary_at is left where it was so the window carries forward", async () => {
    const priorAt = new Date(cutoff.getTime() - DAY_MS);
    await setLastSummaryAt(priorAt);
    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();

    const [row] = await tdb.db.select().from(nodSettings);
    expect(row!.bounceSummaryAt).toEqual(priorAt);
  });

  it("nothing to report, ever (bounce_summary_at still null): no email, and it stays null", async () => {
    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();

    const [row] = await tdb.db.select().from(nodSettings);
    expect(row!.bounceSummaryAt).toBeNull();
  });

  it("unmatched/ignored counts alone (no NoD-side bounces) are still enough to send", async () => {
    await setLastSummaryAt(new Date(cutoff.getTime() - DAY_MS));
    const distribution = stubDistribution();
    distribution.bounceStats.mockResolvedValue({ unmatched: 2, ignored: 1 });

    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(result).toEqual({ sent: true, lines: 0 });
    expect(distribution.send).toHaveBeenCalledTimes(1);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.text).toContain("Unmatched: 2; ignored: 1.");
  });

  it("default window with no prior summary: 24h before now, not before", async () => {
    // bounceSummaryAt stays null (beforeEach default) -- first run ever.
    const sub = await insertSubscriber(tdb.db, "window@example.test");
    const inWindow = new Date(Date.now() - 23 * HOUR_MS);
    const tooOld = new Date(Date.now() - 25 * HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at: inWindow, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", inWindow);
    // A second subscriber whose only bounce is outside the 24h window -- must not appear.
    const old = await insertSubscriber(tdb.db, "toolold@example.test");
    await insertHardBounceDelivery(tdb.db, old, { at: tooOld, status: "5.1.1" });
    await insertHistory(tdb.db, old, "bounce-recorded", "5.1.1", tooOld);

    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(result).toEqual({ sent: true, lines: 1 });
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.text).toContain("window@example.test");
    expect(req.text).not.toContain("toolold@example.test");
  });

  it("body lines: recorded, disabled and flagged, media members bold, with the unmatched/ignored counts and the subject format", async () => {
    await setLastSummaryAt(new Date(cutoff.getTime() - DAY_MS));
    const at = new Date(cutoff.getTime() - HOUR_MS);

    const recorded = await insertSubscriber(tdb.db, "recorded@example.test");
    await insertHardBounceDelivery(tdb.db, recorded, { at, status: "5.1.1" });
    await insertHistory(tdb.db, recorded, "bounce-recorded", "5.1.1", at);

    const disabled = await insertSubscriber(tdb.db, "disabled@example.test");
    await insertHardBounceDelivery(tdb.db, disabled, { at, status: "5.2.1" });
    await insertHistory(tdb.db, disabled, "bounce-disabled", "10/15d", at);

    const flagged = await insertSubscriber(tdb.db, "flagged@example.test");
    await makeMediaMember(tdb.db, flagged);
    await insertHardBounceDelivery(tdb.db, flagged, { at, status: "5.1.1" });
    await insertHistory(tdb.db, flagged, "bounce-flagged", "", at);

    const distribution = stubDistribution();
    distribution.bounceStats.mockResolvedValue({ unmatched: 4, ignored: 2 });

    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    expect(result).toEqual({ sent: true, lines: 3 });
    expect(distribution.bounceStats).toHaveBeenCalledWith(new Date(cutoff.getTime() - DAY_MS).toISOString());

    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.priority).toBe("system");
    const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(cutoff);
    expect(req.subject).toBe(`News On Demand - Bounce Manager - ${dateLabel}`);
    expect(req.idempotencyKey).toBe(`nod-bounce-summary-${dateLabel}`);

    expect(req.text).toContain("recorded@example.test - hard (5.1.1): recorded (1/15d)");
    expect(req.text).toContain("disabled@example.test - hard (5.2.1): disabled (10/15d)");
    expect(req.text).toContain("flagged@example.test - hard (5.1.1): flagged — media list member");
    expect(req.text).toContain("Unmatched: 4; ignored: 2.");

    // Media members are bolded in the html part, not the text part -- the recorded/disabled
    // lines (not media members here) are never wrapped.
    expect(req.html).toContain("<b>flagged@example.test - hard (5.1.1): flagged — media list member</b>");
    expect(req.html).not.toContain("<b>recorded@example.test");
    expect(req.html).not.toContain("<b>disabled@example.test");
  });

  it("HTML-escapes addresses", async () => {
    await setLastSummaryAt(new Date(cutoff.getTime() - DAY_MS));
    const at = new Date(cutoff.getTime() - HOUR_MS);
    // A display form the DB may legitimately hold is irrelevant here -- what matters is that a
    // value containing HTML-special characters is never written into the body unescaped. Reuse
    // a normal-looking address and instead assert the status code (attacker-influenced upstream)
    // is escaped, since subscribers.email itself is schema-validated elsewhere.
    const sub = await insertSubscriber(tdb.db, "escape@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1 <bad>" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1 <bad>", at);

    const distribution = stubDistribution();
    await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.html).not.toContain("<bad>");
    expect(req.html).toContain("&lt;bad&gt;");
  });

  it("concurrent runs send exactly one summary", async () => {
    await setLastSummaryAt(new Date(cutoff.getTime() - DAY_MS));
    const sub = await insertSubscriber(tdb.db, "concurrent@example.test");
    const at = new Date(cutoff.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    const [a, b] = await Promise.all([
      runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com"),
      runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com"),
    ]);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
    expect(distribution.send).toHaveBeenCalledTimes(1);
  });

  it("never logs an address", async () => {
    await setLastSummaryAt(new Date(cutoff.getTime() - DAY_MS));
    const sub = await insertSubscriber(tdb.db, "secret-address@example.test");
    const at = new Date(cutoff.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const distribution = stubDistribution();
      await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com");
      for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
        expect(call.join(" ")).not.toContain("secret-address@example.test");
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("a send failure leaves bounce_summary_at where it was, so the next tick retries the whole window", async () => {
    const priorAt = new Date(cutoff.getTime() - DAY_MS);
    await setLastSummaryAt(priorAt);
    const sub = await insertSubscriber(tdb.db, "retry@example.test");
    const at = new Date(cutoff.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new Error("Distribution unreachable"));

    await expect(runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com")).rejects.toThrow();
    const [row] = await tdb.db.select().from(nodSettings);
    expect(row!.bounceSummaryAt).toEqual(priorAt);
  });
});

describe("startBounceSummaryLoop", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE subscriber_history, deliveries, subscriptions, subscribers CASCADE");
    await tdb.db.update(nodSettings).set({ bounceSummaryAt: null }).where(eq(nodSettings.id, 1));
  });

  it("runs the worker on each tick until due, and stop() clears the interval", async () => {
    const dueCutoff = dailyCutoff(new Date(), TZ, BOUNCE_SUMMARY_HOUR);
    await tdb.db.update(nodSettings).set({ bounceSummaryAt: new Date(dueCutoff.getTime() - DAY_MS) }).where(eq(nodSettings.id, 1));
    const sub = await insertSubscriber(tdb.db, "loop@example.test");
    const at = new Date(dueCutoff.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    const stop = startBounceSummaryLoop({ db: tdb.db, distribution, timeZone: TZ, to: "ops@example.com", intervalMs: 20 });
    await vi.waitFor(() => {
      expect(distribution.send).toHaveBeenCalledTimes(1);
    });
    await stop();

    await new Promise((r) => setTimeout(r, 60));
    expect(distribution.send).toHaveBeenCalledTimes(1);
  });
});
