import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db, TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { BOUNCE_SUMMARY_HOUR, runBounceSummaryIfDue, startBounceSummaryLoop } from "./bounce-summary";
import { BOUNCE_ACTOR } from "./bounces";
import type { DistributionClient, MessageRequest } from "./distribution-client";
import { todaysCutoff } from "./digest";
import { deliveries, nodSettings, subscriberHistory, subscribers, subscriptions } from "./db/schema";

const TZ = "America/Vancouver";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// All anchored to *today's* real 08:00 BC-time cutoff (never a hardcoded calendar date):
// bounces.ts's own countBouncedEmails/thresholdTripped compare against Postgres's real
// `now()` (no test-clock hook there), so a fixture dated too far from the real wall clock
// would silently fall outside their 15-day window. Only the module under test here
// (bounce-summary.ts's own `claim`) takes the injected `now` below -- everything else these
// tests touch still runs against the real clock, so every instant must stay plausible against
// it. Relative order is all that matters, same reasoning as digest.test.ts's own `cutoff`.
const DAY1_0800 = todaysCutoff(new Date(), TZ, BOUNCE_SUMMARY_HOUR); // today's 08:00 BC time
const DAY1_0300 = new Date(DAY1_0800.getTime() - 5 * HOUR_MS); // before that day's 08:00
const DAY1_0805 = new Date(DAY1_0800.getTime() + 5 * 60_000); // just past it
const DAY1_1400 = new Date(DAY1_0800.getTime() + 6 * HOUR_MS);
const DAY1_1405 = new Date(DAY1_1400.getTime() + 5 * 60_000);
const DAYMINUS2_0800 = new Date(DAY1_0800.getTime() - 2 * DAY_MS); // two days earlier's 08:00
const DAY2_0800 = new Date(DAY1_0800.getTime() + DAY_MS); // the next day's 08:00
const DAY2_0805 = new Date(DAY2_0800.getTime() + 5 * 60_000);
const DAY3_0800 = new Date(DAY2_0800.getTime() + DAY_MS);

type Row = { address: string; status?: string | null; message?: string | null; subject?: string | null };
const row = (r: Row) => ({ status: null, message: null, subject: null, processedAt: new Date().toISOString(), ...r });
function summaryOf(o: { soft?: Row[]; unrecorded?: Row[]; ignored?: number } = {}) {
  const soft = (o.soft ?? []).map(row);
  const unrecorded = (o.unrecorded ?? []).map(row);
  return {
    processed: soft.length + unrecorded.length + (o.ignored ?? 0),
    bounces: soft.length + unrecorded.length,
    ignored: o.ignored ?? 0,
    soft: { count: soft.length, rows: soft },
    unrecorded: { count: unrecorded.length, rows: unrecorded },
  };
}
function stubDistribution(): DistributionClient & { send: ReturnType<typeof vi.fn>; bounceSummary: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({ batchId: "batch-summary" }),
    bounceSummary: vi.fn().mockResolvedValue(summaryOf()),
  } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn>; bounceSummary: ReturnType<typeof vi.fn> };
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

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE subscriber_history, deliveries, subscriptions, subscribers CASCADE");
    await tdb.db
      .update(nodSettings)
      .set({ bounceSummaryAt: null, bounceSummaryCheckedAt: null, bounceSummaryLease: null, bounceSummaryLeaseUntil: null, bounceSummaryEmail: null, bounceSoftCodesCounted: [] })
      .where(eq(nodSettings.id, 1));
  });

  async function setCheckedAt(d: Date | null): Promise<void> {
    await tdb.db.update(nodSettings).set({ bounceSummaryCheckedAt: d }).where(eq(nodSettings.id, 1));
  }

  it("no recipient configured: never sends, never touches the database", async () => {
    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, null, () => DAY1_0800);
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();
    expect(distribution.bounceSummary).not.toHaveBeenCalled();
  });

  it("before 08:00 BC time: an older checked_at stamp still doesn't send", async () => {
    await setCheckedAt(DAYMINUS2_0800);
    const sub = await insertSubscriber(tdb.db, "early-older@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_0300, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", DAY1_0300);

    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0300);
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();
    expect(distribution.bounceSummary).not.toHaveBeenCalled();
  });

  it("before 08:00 BC time: a null checked_at (first run ever) still doesn't send", async () => {
    // checked_at stays null (beforeEach default).
    const sub = await insertSubscriber(tdb.db, "early-null@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_0300, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", DAY1_0300);

    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0300);
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();
    expect(distribution.bounceSummary).not.toHaveBeenCalled();
  });

  it("a no-op 08:00 run doesn't fire again that same day once a bounce lands, but the next day's run includes it", async () => {
    const first = stubDistribution();
    const result1 = await runBounceSummaryIfDue(tdb.db, first, TZ, "ops@example.com", () => DAY1_0805);
    expect(result1).toEqual({ sent: false, lines: 0 });
    expect(first.send).not.toHaveBeenCalled();
    const [afterNoOp] = await tdb.db.select().from(nodSettings);
    expect(afterNoOp!.bounceSummaryCheckedAt).toEqual(DAY1_0800);
    // First run ever, even as a no-op, stamps bounce_summary_at to its own window start.
    expect(afterNoOp!.bounceSummaryAt).toEqual(new Date(DAY1_0805.getTime() - DAY_MS));

    const sub = await insertSubscriber(tdb.db, "midday@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_1400, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", DAY1_1400);

    const second = stubDistribution();
    const result2 = await runBounceSummaryIfDue(tdb.db, second, TZ, "ops@example.com", () => DAY1_1405);
    expect(result2).toEqual({ sent: false, lines: 0 });
    expect(second.send).not.toHaveBeenCalled();

    const third = stubDistribution();
    const result3 = await runBounceSummaryIfDue(tdb.db, third, TZ, "ops@example.com", () => DAY2_0805);
    expect(result3).toEqual({ sent: true, lines: 1 });
    expect(third.send).toHaveBeenCalledTimes(1);
    const req = third.send.mock.calls[0]![0] as MessageRequest;
    expect(req.text).toContain("midday@example.test");
  });

  it("nothing to report on the very first run ever: sets checked_at, and also stamps bounce_summary_at to that run's own window start (closing the pre-first-send gap)", async () => {
    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(distribution.send).not.toHaveBeenCalled();

    const [row] = await tdb.db.select().from(nodSettings);
    expect(row!.bounceSummaryCheckedAt).toEqual(DAY1_0800);
    expect(row!.bounceSummaryAt).toEqual(new Date(DAY1_0800.getTime() - DAY_MS));
  });

  it("nothing to report on a later no-op run: checked_at moves, but a bounce_summary_at already set stays exactly where it was", async () => {
    const sub = await insertSubscriber(tdb.db, "already-summarized@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);
    const first = stubDistribution();
    await runBounceSummaryIfDue(tdb.db, first, TZ, "ops@example.com", () => DAY1_0800);
    const [afterFirst] = await tdb.db.select().from(nodSettings);
    const stampedAt = afterFirst!.bounceSummaryAt;
    expect(stampedAt).not.toBeNull();

    const second = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, second, TZ, "ops@example.com", () => DAY2_0800);
    expect(result).toEqual({ sent: false, lines: 0 });
    expect(second.send).not.toHaveBeenCalled();

    const [row] = await tdb.db.select().from(nodSettings);
    expect(row!.bounceSummaryCheckedAt).toEqual(DAY2_0800);
    expect(row!.bounceSummaryAt).toEqual(stampedAt); // unchanged -- only the first-ever run stamps it on a no-op
  });

  it("an ignored-only window sends no email; an unrecorded-only or soft-only window does", async () => {
    const ignoredOnly = stubDistribution();
    ignoredOnly.bounceSummary.mockResolvedValue(summaryOf({ ignored: 3 }));
    const resultIgnored = await runBounceSummaryIfDue(tdb.db, ignoredOnly, TZ, "ops@example.com", () => DAY1_0800);
    expect(resultIgnored).toEqual({ sent: false, lines: 0 });
    expect(ignoredOnly.send).not.toHaveBeenCalled();
    const [afterIgnored] = await tdb.db.select().from(nodSettings);
    expect(afterIgnored!.bounceSummaryCheckedAt).toEqual(DAY1_0800);
    // This is still the very first run ever, so even though it's a no-op it stamps
    // bounce_summary_at to its own window start.
    expect(afterIgnored!.bounceSummaryAt).toEqual(new Date(DAY1_0800.getTime() - DAY_MS));

    const unrecordedOnly = stubDistribution();
    unrecordedOnly.bounceSummary.mockResolvedValue(summaryOf({ unrecorded: Array.from({ length: 2 }, (_, i) => ({ address: `u${i}@example.test` })), ignored: 1 }));
    const resultUnrecorded = await runBounceSummaryIfDue(tdb.db, unrecordedOnly, TZ, "ops@example.com", () => DAY2_0800);
    expect(resultUnrecorded).toEqual({ sent: true, lines: 0 });
    expect(unrecordedOnly.send).toHaveBeenCalledTimes(1);
    const req = unrecordedOnly.send.mock.calls[0]![0] as MessageRequest;
    expect(req.text).toContain("Unrecorded bounces (2)");

    const softOnly = stubDistribution();
    softOnly.bounceSummary.mockResolvedValue(summaryOf({ soft: [{ address: "soft-only@example.test", status: "4.2.2" }] }));
    const resultSoft = await runBounceSummaryIfDue(tdb.db, softOnly, TZ, "ops@example.com", () => DAY3_0800);
    expect(resultSoft).toEqual({ sent: true, lines: 0 });
    expect((softOnly.send.mock.calls[0]![0] as MessageRequest).text).toContain("Soft bounces (1)");
  });

  it("default window with no prior summary: 24h before dbNow, not before", async () => {
    const sub = await insertSubscriber(tdb.db, "window@example.test");
    const inWindow = new Date(DAY1_0800.getTime() - 23 * HOUR_MS);
    const tooOld = new Date(DAY1_0800.getTime() - 25 * HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at: inWindow, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", inWindow);
    const old = await insertSubscriber(tdb.db, "toolold@example.test");
    await insertHardBounceDelivery(tdb.db, old, { at: tooOld, status: "5.1.1" });
    await insertHistory(tdb.db, old, "bounce-recorded", "5.1.1", tooOld);

    const distribution = stubDistribution();
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
    expect(result).toEqual({ sent: true, lines: 1 });
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.text).toContain("window@example.test");
    expect(req.text).not.toContain("toolold@example.test");
  });

  it("body lines: recorded, disabled and flagged, media members bold, with the unrecorded/ignored counts and the subject format", async () => {
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);

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
    distribution.bounceSummary.mockResolvedValue(summaryOf({ unrecorded: Array.from({ length: 4 }, (_, i) => ({ address: `u${i}@example.test` })), ignored: 2 }));

    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
    expect(result).toEqual({ sent: true, lines: 3 });
    expect(distribution.bounceSummary).toHaveBeenCalledWith(new Date(DAY1_0800.getTime() - 24 * HOUR_MS).toISOString(), DAY1_0800.toISOString());

    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.priority).toBe("system");
    const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(DAY1_0800);
    expect(req.subject).toBe(`News On Demand - Bounce Manager - ${dateLabel}`);
    expect(req.idempotencyKey).toBe(`nod-bounce-summary-${dateLabel}`);

    expect(req.text).toContain("recorded@example.test - hard (5.1.1): recorded (1/15d)");
    expect(req.text).toContain("disabled@example.test - hard (5.2.1): disabled (10/15d)");
    expect(req.text).toContain("flagged@example.test - hard (5.1.1): flagged — media list member");
    expect(req.text).toContain("Unrecorded bounces (4)");
    expect(req.text).toContain("2 other messages");

    expect(req.html).toContain("<b>flagged@example.test - hard (5.1.1): flagged — media list member</b>");
    expect(req.html).not.toContain("<b>recorded@example.test");
    expect(req.html).not.toContain("<b>disabled@example.test");
  });

  it("HTML-escapes an address that itself contains markup", async () => {
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    // Inserted directly (bypassing the normal subscribe flow's own email validation) to prove
    // the summary's own rendering never trusts stored data -- a defence-in-depth check, not a
    // claim that this shape can arrive through the public API today.
    const sub = await insertSubscriber(tdb.db, "a&b<script>@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.html).not.toContain("a&b<script>@example.test");
    expect(req.html).toContain("a&amp;b&lt;script&gt;@example.test");
    // The text part carries no markup at all, so it's never escaped.
    expect(req.text).toContain("a&b<script>@example.test");
  });

  it("concurrent runs send exactly one summary", async () => {
    const sub = await insertSubscriber(tdb.db, "concurrent@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    const [a, b] = await Promise.all([
      runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800),
      runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800),
    ]);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
    expect(distribution.send).toHaveBeenCalledTimes(1);
  });

  it("an active lease: a concurrent call skips without calling bounceSummary", async () => {
    const sub = await insertSubscriber(tdb.db, "lease-active@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const distributionA = stubDistribution();
    distributionA.bounceSummary.mockImplementation(async () => {
      await gate;
      return summaryOf();
    });

    const callA = runBounceSummaryIfDue(tdb.db, distributionA, TZ, "a@example.com", () => DAY1_0800);
    await vi.waitFor(async () => {
      const [row] = await tdb.db.select().from(nodSettings);
      expect(row!.bounceSummaryLease).not.toBeNull();
    });

    const distributionB = stubDistribution();
    const resultB = await runBounceSummaryIfDue(tdb.db, distributionB, TZ, "b@example.com", () => DAY1_0800);
    expect(resultB).toEqual({ sent: false, lines: 0 });
    expect(distributionB.bounceSummary).not.toHaveBeenCalled();
    expect(distributionB.send).not.toHaveBeenCalled();

    release();
    await callA;
  });

  it("a failed send is retried on the next due check, sending exactly once under the date's own idempotency key", async () => {
    const sub = await insertSubscriber(tdb.db, "retry@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValueOnce(new Error("Distribution unreachable"));

    await expect(runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800)).rejects.toThrow();
    const [afterFailure] = await tdb.db.select().from(nodSettings);
    expect(afterFailure!.bounceSummaryLease).toBeNull();
    expect(afterFailure!.bounceSummaryCheckedAt).toBeNull();
    expect(afterFailure!.bounceSummaryAt).toBeNull();

    distribution.send.mockResolvedValueOnce({ batchId: "ok" });
    const result2 = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
    expect(result2).toEqual({ sent: true, lines: 1 });
    expect(distribution.send).toHaveBeenCalledTimes(2);
    const key1 = (distribution.send.mock.calls[0]![0] as MessageRequest).idempotencyKey;
    const key2 = (distribution.send.mock.calls[1]![0] as MessageRequest).idempotencyKey;
    expect(key1).toBe(key2);
  });

  it("finish() itself throwing inside the catch does not mask the original error, and logs the finish failure safely", async () => {
    const sub = await insertSubscriber(tdb.db, "finish-throws@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValueOnce(new Error("original send failure"));

    // The only top-level db.update in this whole flow is finish()'s own -- claim()'s update
    // runs inside its own transaction-scoped tx, a different object -- so this proxy's first
    // call is unambiguously finish()'s.
    let updateCalls = 0;
    const flakyDb = new Proxy(tdb.db, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (...args: unknown[]) => {
            updateCalls++;
            if (updateCalls === 1) throw new Error("finish DB failure for finish-throws@example.test");
            return (target.update as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runBounceSummaryIfDue(flakyDb, distribution, TZ, "ops@example.com", () => DAY1_0800)).rejects.toThrow("original send failure");
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("finish-throws@example.test");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a stale runner's finish after a takeover does not re-stamp", async () => {
    const sub = await insertSubscriber(tdb.db, "stale@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const distributionA = stubDistribution();
    distributionA.bounceSummary.mockImplementation(async () => {
      await gate;
      return summaryOf();
    });

    const callA = runBounceSummaryIfDue(tdb.db, distributionA, TZ, "a@example.com", () => DAY1_0800);
    await vi.waitFor(async () => {
      const [row] = await tdb.db.select().from(nodSettings);
      expect(row!.bounceSummaryLease).not.toBeNull();
    });

    // A's lease now looks abandoned (crashed, or simply took far longer than its 5-minute
    // window) -- force it into the past *relative to the injected `now` both runners use*
    // (real `now()` is irrelevant here: B's own claim compares against DAY1_0800, not the
    // wall clock) so B's own claim sees it as free.
    await tdb.pool.query("UPDATE nod_settings SET bounce_summary_lease_until = $1 WHERE id = 1", [new Date(DAY1_0800.getTime() - 1_000).toISOString()]);

    const distributionB = stubDistribution();
    const resultB = await runBounceSummaryIfDue(tdb.db, distributionB, TZ, "b@example.com", () => DAY1_0800);
    expect(resultB).toEqual({ sent: true, lines: 1 });
    const [afterB] = await tdb.db.select().from(nodSettings);
    const stampAfterB = { checkedAt: afterB!.bounceSummaryCheckedAt, at: afterB!.bounceSummaryAt, lease: afterB!.bounceSummaryLease };
    expect(stampAfterB.lease).toBeNull();

    // Only now does A resume -- its own finish uses a lease the row no longer holds, so it
    // must not touch what B already wrote.
    release();
    await callA;

    const [afterA] = await tdb.db.select().from(nodSettings);
    expect(afterA!.bounceSummaryCheckedAt).toEqual(stampAfterB.checkedAt);
    expect(afterA!.bounceSummaryAt).toEqual(stampAfterB.at);
    expect(afterA!.bounceSummaryLease).toBeNull();

    // A still sends its own copy (its own distribution client, never told it lost the race) --
    // under the same date's idempotency key as B's, so Distribution's own dedupe (not this
    // takeover) is what keeps the subscriber from getting two summary emails.
    expect(distributionA.send).toHaveBeenCalledTimes(1);
    const keyA = (distributionA.send.mock.calls[0]![0] as MessageRequest).idempotencyKey;
    const keyB = (distributionB.send.mock.calls[0]![0] as MessageRequest).idempotencyKey;
    expect(keyA).toBe(keyB);
  });

  it("never logs an address on a normal send", async () => {
    const sub = await insertSubscriber(tdb.db, "secret-address@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const distribution = stubDistribution();
      await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
      for (const call of [...logSpy.mock.calls, ...errorSpy.mock.calls]) {
        expect(call.join(" ")).not.toContain("secret-address@example.test");
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("lists soft and unrecorded bounces, marks subscribers and bolds media members", async () => {
    const media = await insertSubscriber(tdb.db, "Soft-Media@example.test");
    await makeMediaMember(tdb.db, media);
    await insertSubscriber(tdb.db, "known@example.test");
    const distribution = stubDistribution();
    distribution.bounceSummary.mockResolvedValue(
      summaryOf({
        soft: [{ address: "soft-media@example.test", status: "4.2.2", message: "452 4.2.2 mailbox full", subject: "BC Gov News - Clinics" }],
        unrecorded: [
          { address: "KNOWN@example.test", status: "5.1.1", message: "550 5.1.1 not found", subject: "BC Gov News On Demand Email Verification" },
          { address: "stranger@example.test", status: "5.4.316", message: "Message expired", subject: "Old release" },
        ],
      }),
    );
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
    expect(result).toEqual({ sent: true, lines: 0 });
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.text).toContain("soft-media@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics");
    expect(req.html).toContain("<b>soft-media@example.test (4.2.2");
    expect(req.text).toContain("KNOWN@example.test (5.1.1 550 5.1.1 not found) - BC Gov News On Demand Email Verification - NoD subscriber (active)");
    expect(req.text).toContain("stranger@example.test (5.4.316 Message expired) - Old release - not a NoD subscriber");
  });

  it("a soft code staff count as hard is not listed again among soft bounces", async () => {
    await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: ["4.2.2"] }).where(eq(nodSettings.id, 1));
    try {
      const sub = await insertSubscriber(tdb.db, "counted@example.test");
      await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_0300, status: "4.2.2" });
      await insertHistory(tdb.db, sub, "bounce-recorded", "4.2.2", DAY1_0300);
      const distribution = stubDistribution();
      distribution.bounceSummary.mockResolvedValue(summaryOf({ soft: [{ address: "counted@example.test", status: "4.2.2" }, { address: "full@example.test", status: "4.4.7" }] }));
      await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
      const req = distribution.send.mock.calls[0]![0] as MessageRequest;
      expect(req.text).toContain("counted@example.test - soft, counted as hard (4.2.2): recorded (1/15d)");
      expect(req.text).toContain("Soft bounces (1)");
      expect(req.text).not.toContain("counted@example.test (4.2.2");
    } finally {
      await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: [] }).where(eq(nodSettings.id, 1));
    }
  });

  it("a soft bounce with a counted code but no hard line in the window is still listed among soft bounces", async () => {
    await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: ["4.2.2"] }).where(eq(nodSettings.id, 1));
    try {
      const sub = await insertSubscriber(tdb.db, "counted-hard@example.test");
      await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_0300, status: "4.2.2" });
      await insertHistory(tdb.db, sub, "bounce-recorded", "4.2.2", DAY1_0300);
      const distribution = stubDistribution();
      distribution.bounceSummary.mockResolvedValue(
        summaryOf({
          soft: [
            { address: "COUNTED-HARD@example.test", status: "4.2.2" },
            { address: "verify-only@example.test", status: "4.2.2", message: "452 4.2.2 mailbox full" },
          ],
        }),
      );
      await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
      const req = distribution.send.mock.calls[0]![0] as MessageRequest;
      expect(req.text).toContain("Soft bounces (1)");
      expect(req.text).toContain("verify-only@example.test (4.2.2 452 4.2.2 mailbox full)");
      expect(req.text).not.toContain("COUNTED-HARD@example.test (4.2.2");
    } finally {
      await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: [] }).where(eq(nodSettings.id, 1));
    }
  });

  it("Distribution down: no partial summary, lease cleared, retried on the next due check", async () => {
    const sub = await insertSubscriber(tdb.db, "partial@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_0300, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", DAY1_0300);
    const down = stubDistribution();
    down.bounceSummary.mockRejectedValue(new Error("Distribution responded HTTP 503"));
    await expect(runBounceSummaryIfDue(tdb.db, down, TZ, "ops@example.com", () => DAY1_0805)).rejects.toThrow();
    expect(down.send).not.toHaveBeenCalled();
    const [s] = await tdb.db.select().from(nodSettings);
    expect(s!.bounceSummaryLease).toBeNull();
    expect(s!.bounceSummaryCheckedAt).toBeNull();

    const up = stubDistribution();
    expect((await runBounceSummaryIfDue(tdb.db, up, TZ, "ops@example.com", () => DAY1_0805)).sent).toBe(true);
  });

  it("sends to the staff-set address ahead of the server default", async () => {
    await tdb.db.update(nodSettings).set({ bounceSummaryEmail: "summary-staff@example.test" }).where(eq(nodSettings.id, 1));
    const distribution = stubDistribution();
    distribution.bounceSummary.mockResolvedValue(summaryOf({ unrecorded: Array.from({ length: 1 }, (_, i) => ({ address: `u${i}@example.test` })), ignored: 0 }));
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "server-default@example.test", () => DAY1_0805);
    expect(result.sent).toBe(true);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).recipients).toEqual([{ email: "summary-staff@example.test", substitutions: {} }]);
  });

  it("a staff-set address sends even with no server default", async () => {
    await tdb.db.update(nodSettings).set({ bounceSummaryEmail: "summary-staff@example.test" }).where(eq(nodSettings.id, 1));
    const distribution = stubDistribution();
    distribution.bounceSummary.mockResolvedValue(summaryOf({ unrecorded: Array.from({ length: 1 }, (_, i) => ({ address: `u${i}@example.test` })), ignored: 0 }));
    expect((await runBounceSummaryIfDue(tdb.db, distribution, TZ, null, () => DAY1_0805)).sent).toBe(true);
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
    await tdb.db
      .update(nodSettings)
      .set({ bounceSummaryAt: null, bounceSummaryCheckedAt: null, bounceSummaryLease: null, bounceSummaryLeaseUntil: null })
      .where(eq(nodSettings.id, 1));
  });

  it("runs the worker on each tick until due, and stop() clears the interval", async () => {
    const sub = await insertSubscriber(tdb.db, "loop@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    const stop = startBounceSummaryLoop({ db: tdb.db, distribution, timeZone: TZ, to: "ops@example.com", intervalMs: 20, now: () => DAY1_0800 });
    await vi.waitFor(() => {
      expect(distribution.send).toHaveBeenCalledTimes(1);
    });
    await stop();

    await new Promise((r) => setTimeout(r, 60));
    // checked_at is now stamped for this fixed "now", so later ticks (same fixed instant) find
    // nothing further due.
    expect(distribution.send).toHaveBeenCalledTimes(1);
  });

  it("never logs an address, even when the failure's own Error message carries one", async () => {
    const sub = await insertSubscriber(tdb.db, "leaky@example.test");
    const at = new Date(DAY1_0800.getTime() - HOUR_MS);
    await insertHardBounceDelivery(tdb.db, sub, { at, status: "5.1.1" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", at);

    const distribution = stubDistribution();
    distribution.send.mockRejectedValue(new Error("failed to deliver to leaky@example.test: connection reset"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stop = startBounceSummaryLoop({ db: tdb.db, distribution, timeZone: TZ, to: "ops@example.com", intervalMs: 20, now: () => DAY1_0800 });
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalled();
      });
      await stop();
      expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
      for (const call of errorSpy.mock.calls) {
        expect(call.join(" ")).not.toContain("leaky@example.test");
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
