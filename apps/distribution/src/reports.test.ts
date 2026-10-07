import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../test/helpers";
import { batches, messages } from "./db/schema";
import { dailyReport, dailyReportSchema, dailyReportSql } from "./reports";

// BC midnights either side of 2026-11-01: 07:00Z both, BC stays on UTC−7 (NoD computes these).
const BOUNDS = ["2026-10-31T07:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-02T07:00:00.000Z"].map((s) => new Date(s));

describe("Distribution daily report", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
    const [nod, nrms] = await tdb.db
      .insert(batches)
      .values([
        { appId: "nod", subject: "s", html: "<p>h</p>", createdAt: new Date("2026-10-31T20:00:00Z") },
        { appId: "nrms", subject: "s", html: "<p>h</p>", createdAt: new Date("2026-11-01T09:00:00Z") },
      ])
      .returning({ id: batches.id });
    const m = (batchId: string, over: Partial<typeof messages.$inferInsert>) => ({ batchId, email: "x@example.test", priority: 30, ...over });
    await tdb.db.insert(messages).values([
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-01T06:30:00Z") }), // 23:30 BC on Oct 31
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-01T07:30:00Z"), bouncedAt: new Date(), bounceHard: true }),
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-01T08:00:00Z"), bouncedAt: new Date(), bounceHard: false }),
      m(nod!.id, { status: "failed" }),
      m(nod!.id, { status: "pending" }),
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-02T07:00:00Z") }), // first instant after the range
      m(nrms!.id, { status: "sent", sentAt: new Date("2026-11-01T10:00:00Z") }),
    ]);
  });
  afterAll(async () => tdb.drop());

  it("counts by the given day boundaries and app: sent and bounces by send time, failures by queue time", async () => {
    expect(await dailyReport(tdb.db, BOUNDS)).toEqual([
      { day: 0, appId: "nod", sent: 1, hardBounced: 0, softBounced: 0, failed: 1 },
      { day: 1, appId: "nod", sent: 2, hardBounced: 1, softBounced: 1, failed: 0 },
      { day: 1, appId: "nrms", sent: 1, hardBounced: 0, softBounced: 0, failed: 0 },
    ]);
  });

  it("reads a month out of a long history through messages_sent_at_idx", async () => {
    const [b] = await tdb.db.insert(batches).values({ appId: "nod", subject: "s", html: "<p>h</p>" }).returning({ id: batches.id });
    await tdb.db.execute(sql.raw(`
      INSERT INTO messages (batch_id, email, priority, status, sent_at)
      SELECT '${b!.id}', 'user' || g || '@example.test', 30, 'sent', now() - ((g % 400) || ' days')::interval
        FROM generate_series(1, 60000) g;
      ANALYZE messages;
    `));
    const now = Date.now();
    const month = Array.from({ length: 31 }, (_, i) => new Date(now - (30 - i) * 86_400_000));
    const { rows } = await tdb.db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${dailyReportSql(month)}`);
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("messages_sent_at_idx");
    expect(plan).not.toMatch(/Seq Scan on messages/);
  });

  it("accepts at most 93 days from the first boundary to the last, however few boundaries there are", () => {
    const ok = (bounds: string[]) => dailyReportSchema.safeParse({ bounds }).success;
    // 92 BC days across a fall-back: one hour longer than 92 x 24 h.
    expect(ok(["2025-09-01T07:00:00.000Z", "2025-12-02T08:00:00.000Z"])).toBe(true);
    expect(ok(["2026-01-01T08:00:00.000Z", "2026-04-04T08:00:00.000Z"])).toBe(true);
    expect(ok(["2026-01-01T08:00:00.000Z", "2026-04-04T08:00:00.001Z"])).toBe(false);
    expect(ok(["2026-01-01T08:00:00.000Z", "2026-02-01T08:00:00.000Z", "2026-12-31T08:00:00.000Z"])).toBe(false);
  });
});
