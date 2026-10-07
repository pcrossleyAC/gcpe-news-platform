import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { mediaOptOuts, subscriberHistory, subscribers } from "./db/schema";
import { ALL_MEDIA_LISTS, keepMediaOptOuts, optOutHash, suppressedOptOutAt } from "./opt-outs";

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

  const at = (d: string) => new Date(`2026-${d}T17:00:00Z`);
  const keptFor = async (email: string) =>
    (await tdb.db.select().from(mediaOptOuts).where(eq(mediaOptOuts.emailHash, optOutHash(email))))
      .map((r) => [r.listKey, r.optedOutAt.toISOString()])
      .sort();

  it("an ended record that unsubscribed after its last media add is kept as out of every list", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "left@example.test", status: "deleted" }).returning();
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: s!.id, actor: "staff", action: "media-list-added", detail: "media-distribution-lists:budget", at: at("02-01") },
      { subscriberId: s!.id, actor: "staff", action: "media-list-added", detail: "media-distribution-lists:health", at: at("02-01") },
      { subscriberId: s!.id, actor: "staff", action: "media-list-removed", detail: "media-distribution-lists:health", at: at("03-01") },
      { subscriberId: s!.id, actor: "self", action: "unsubscribed", at: at("04-01") },
    ]);
    await keepMediaOptOuts(tdb.db, s!);
    expect(await keptFor("left@example.test")).toEqual([
      [ALL_MEDIA_LISTS, at("04-01").toISOString()],
      ["media-distribution-lists:budget", at("04-01").toISOString()],
    ]);
    expect(await suppressedOptOutAt(tdb.db, "left@example.test", "media-distribution-lists:anything")).toEqual(at("04-01"));
  });

  it("an unsubscribe counts for a list it ended; a media add after it rules out every-list", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "back@example.test", status: "deleted" }).returning();
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: s!.id, actor: "staff", action: "media-list-added", detail: "media-distribution-lists:budget", at: at("02-01") },
      { subscriberId: s!.id, actor: "self", action: "unsubscribed", at: at("04-01") },
      { subscriberId: s!.id, actor: "staff", action: "media-list-added", detail: "media-distribution-lists:transport", at: at("05-01") },
    ]);
    await keepMediaOptOuts(tdb.db, s!);
    expect(await keptFor("back@example.test")).toEqual([["media-distribution-lists:budget", at("04-01").toISOString()]]);
    expect(await suppressedOptOutAt(tdb.db, "back@example.test", "media-distribution-lists:transport")).toBeNull();
  });

  it("a record that never ended keeps no every-list opt-out", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "unconfirmed@example.test", status: "pending" }).returning();
    await tdb.db.insert(subscriberHistory).values({ subscriberId: s!.id, actor: "self", action: "unsubscribed", at: at("04-01") });
    expect(await keepMediaOptOuts(tdb.db, s!)).toBe(0);
  });
});
