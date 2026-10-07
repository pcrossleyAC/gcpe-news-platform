import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { mediaOptOuts, subscriberHistory, subscribers } from "./db/schema";
import { keepMediaOptOuts, optOutHash, suppressedOptOutAt } from "./opt-outs";

describe("kept media opt-outs", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());

  it("the hash ignores case and surrounding space, and is not the address", () => {
    expect(optOutHash(" Gone@Example.TEST ")).toBe(optOutHash("gone@example.test"));
    expect(optOutHash("gone@example.test")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps each list's latest opt-out, without the address; a later keep only moves it forward", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "gone@example.test", status: "deleted" }).returning();
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: s!.id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:budget", at: new Date("2026-03-01T17:00:00Z") },
      { subscriberId: s!.id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:budget", at: new Date("2026-05-01T17:00:00Z") },
      { subscriberId: s!.id, actor: "self", action: "media-list-opted-out", detail: "media-distribution-lists:transport", at: new Date("2026-04-01T17:00:00Z") },
      { subscriberId: s!.id, actor: "staff", action: "media-list-removed", detail: "media-distribution-lists:health", at: new Date("2026-04-01T17:00:00Z") },
    ]);
    expect(await keepMediaOptOuts(tdb.db, s!)).toBe(2);
    expect(await suppressedOptOutAt(tdb.db, "GONE@example.test", "media-distribution-lists:budget")).toEqual(new Date("2026-05-01T17:00:00Z"));
    expect(await suppressedOptOutAt(tdb.db, "gone@example.test", "media-distribution-lists:health")).toBeNull();
    const rows = await tdb.db.select().from(mediaOptOuts);
    expect(JSON.stringify(rows)).not.toContain("@");

    await tdb.db.execute(sql`UPDATE subscriber_history SET at = '2026-01-01T00:00:00Z' WHERE detail = 'media-distribution-lists:budget'`);
    await keepMediaOptOuts(tdb.db, s!);
    expect(await suppressedOptOutAt(tdb.db, "gone@example.test", "media-distribution-lists:budget")).toEqual(new Date("2026-05-01T17:00:00Z"));
  });
});
