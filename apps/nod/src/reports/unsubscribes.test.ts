import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscriberHistory, subscribers } from "../db/schema";
import { addDays, localDate } from "./range";
import { unsubscribeBatches, unsubscribeDailyCounts, unsubscribesPage, unsubscribesSql, unsubscribeWindow } from "./unsubscribes";

const BC = "America/Vancouver";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("recent unsubscribes", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [alex, blake, casey, dana] = await tdb.db
      .insert(subscribers)
      .values([
        { email: "alex@example.test", status: "active" },
        { email: "blake@example.test", status: "deleted" },
        { email: "casey@example.test", status: "deleted" },
        { email: "dana@example.test", status: "deleted" },
      ])
      .returning({ id: subscribers.id });
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: alex!.id, at: daysAgo(10), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: alex!.id, at: daysAgo(5), actor: "subscriber", action: "resubscribed" },
      { subscriberId: blake!.id, at: daysAgo(2), actor: "Jamie Staff", action: "staff-deleted" },
      { subscriberId: casey!.id, at: daysAgo(100), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: dana!.id, at: daysAgo(20), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: dana!.id, at: daysAgo(3), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: dana!.id, at: daysAgo(30), actor: "subscriber", action: "subscribed" },
      { subscriberId: casey!.id, at: daysAgo(40), actor: "subscriber", action: "confirmed" },
    ]);
  });
  afterAll(async () => tdb.drop());

  it("lists each person's latest unsubscribe in the last 90 days, newest first, with how and their status now", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    const page = await unsubscribesPage(tdb.db, window, 1);
    expect(page.total).toBe(3);
    expect(page.items.map((i) => [i.email, i.how, i.status])).toEqual([
      ["blake@example.test", "staff", "deleted"],
      ["dana@example.test", "subscriber", "deleted"],
      ["alex@example.test", "subscriber", "active"],
    ]);
    expect(localDate(new Date(page.items[1]!.at), BC)).toBe(localDate(daysAgo(3), BC));
    expect(page.summary).toEqual({ subscribed: 2, resubscribed: 1, unsubscribed: 3, staffDeleted: 1 });
  });

  it("starts the window at BC midnight 90 days ago", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    expect(window.since).toBe(addDays(localDate(new Date(), BC), -90));
    expect(window.days).toBe(91);
  });

  it("batches the same rows for the CSV", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    const all: string[] = [];
    for await (const b of unsubscribeBatches(tdb.db, window, 2)) all.push(...b.map((r) => r.email));
    expect(all).toEqual(["blake@example.test", "dana@example.test", "alex@example.test"]);
  });

  it("an unsubscribe that lands while the CSV is being written neither repeats nor drops anyone", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    const [erin] = await tdb.db.insert(subscribers).values({ email: "erin@example.test", status: "active" }).returning({ id: subscribers.id });
    const [alex] = await tdb.db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.email, "alex@example.test"));
    const landed: string[] = [];
    try {
      const all: string[] = [];
      for await (const b of unsubscribeBatches(tdb.db, window, 1)) {
        all.push(...b.map((r) => r.email));
        if (all.length === 1) {
          // Both go to the top of the newest-first order: someone new, and alex (still to come)
          // unsubscribing again.
          const rows = await tdb.db
            .insert(subscriberHistory)
            .values([
              { subscriberId: erin!.id, at: new Date(), actor: "subscriber", action: "unsubscribed" },
              { subscriberId: alex!.id, at: new Date(), actor: "subscriber", action: "unsubscribed" },
            ])
            .returning({ id: subscriberHistory.id });
          landed.push(...rows.map((r) => r.id));
        }
      }
      expect(all).toEqual(["blake@example.test", "dana@example.test", "alex@example.test"]);
    } finally {
      if (landed.length > 0) await tdb.db.delete(subscriberHistory).where(inArray(subscriberHistory.id, landed));
      await tdb.db.delete(subscribers).where(eq(subscribers.id, erin!.id));
    }
  });

  it("counts each BC day of the window, zeros included, without addresses", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    const rows = await unsubscribeDailyCounts(tdb.db, window);
    expect(rows).toHaveLength(91);
    expect(rows.find((r) => r[0] === localDate(daysAgo(2), BC))).toEqual([localDate(daysAgo(2), BC), 0, 0, 0, 1]);
    expect(rows.flat().some((c) => String(c).includes("@"))).toBe(false);
  });

  it("reads subscriber_history through its (action, at) index", async () => {
    await tdb.db.execute(sql.raw(`
      INSERT INTO subscribers (email, status) SELECT 'plan-' || g || '@example.test', 'active' FROM generate_series(1, 1000) g;
      WITH s AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM subscribers WHERE email LIKE 'plan-%')
      INSERT INTO subscriber_history (subscriber_id, at, actor, action)
      SELECT s.id, now() - ((g % 1500) || ' days')::interval, 'subscriber', CASE WHEN g % 3 = 0 THEN 'unsubscribed' ELSE 'preferences-updated' END
        FROM generate_series(1, 50000) g JOIN s ON s.n = g % 1000 + 1;
      ANALYZE subscriber_history;
    `));
    const window = await unsubscribeWindow(tdb.db, BC);
    const { rows } = await tdb.db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${unsubscribesSql(window.start, 50, 0)}`);
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("subscriber_history_action_at_idx");
    expect(plan).not.toContain("Seq Scan on subscriber_history");
  });
});
