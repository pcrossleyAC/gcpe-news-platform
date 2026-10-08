import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../../test/helpers";
import { activities, activityCategories, categories, cities, commContacts, NEEDS_REVIEW_KEYS, type NeedsReviewKey, userProfiles } from "./schema";

const USER = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b";

describe("Calendar schema", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());

  it("keeps legacy ids: explicit ids insert into lookups and activities", async () => {
    await tdb.db.insert(categories).values({ id: 58, name: "Sample category" });
    await tdb.db.insert(cities).values({ id: 311, name: "Other..." });
    const [a] = await tdb.db.insert(activities).values({ id: 90001, title: "Sample", cityId: 311 }).returning({ id: activities.id });
    expect(a!.id).toBe(90001);
    await tdb.db.insert(activityCategories).values({ activityId: 90001, categoryId: 58 });
  });

  it("a row without an id gets one from the identity", async () => {
    const [c] = await tdb.db.insert(categories).values({ name: "Another sample" }).returning({ id: categories.id });
    expect(c!.id).toBeGreaterThan(0);
  });

  it("stores an imported activity with no dates, no comm contact and no contact ministry (C147)", async () => {
    const [a] = await tdb.db.insert(activities).values({ title: "Imported without dates" }).returning();
    expect(a).toMatchObject({ startAt: null, endAt: null, commContactId: null, contactMinistryKey: null, status: "new", hqSection: "events_and_speeches", version: 1, needsReview: [] });
  });

  it("holds exactly the 23 needs-review keys and refuses any other", async () => {
    expect(NEEDS_REVIEW_KEYS).toHaveLength(23);
    await tdb.db.insert(activities).values({ title: "All flags", needsReview: [...NEEDS_REVIEW_KEYS] });
    await expect(tdb.db.insert(activities).values({ title: "Bad flag", needsReview: ["priority"] as unknown as NeedsReviewKey[] })).rejects.toThrow();
  });

  it("refuses an unknown status, HQ status or Look Ahead section", async () => {
    await expect(tdb.db.execute(sql`INSERT INTO activities (title, status) VALUES ('x', 'archived')`)).rejects.toThrow();
    await expect(tdb.db.execute(sql`INSERT INTO activities (title, hq_status) VALUES ('x', 'reviewed')`)).rejects.toThrow();
    await expect(tdb.db.execute(sql`INSERT INTO activities (title, hq_section) VALUES ('x', 'consultations')`)).rejects.toThrow();
  });

  it("refuses text over legacy's column sizes", async () => {
    await expect(tdb.db.insert(activities).values({ title: "x".repeat(501) })).rejects.toThrow();
    await expect(tdb.db.insert(activities).values({ title: "ok", potentialDates: "x".repeat(71) })).rejects.toThrow();
    await tdb.db.insert(activities).values({ title: "x".repeat(217) }); // the longest legacy title (SV 4.5)
  });

  it("allows one comm contact per user and ministry, ranked 1–6", async () => {
    await tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "health", rank: 1 });
    await expect(tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "health", rank: 2 })).rejects.toThrow();
    await expect(tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "finance", rank: 7 })).rejects.toThrow();
  });

  it("keeps legacy's phone format: 12 characters of digits and hyphens", async () => {
    await tdb.db.insert(userProfiles).values({ userId: USER, phone: "250-555-0100", mobile: null });
    await expect(tdb.db.insert(userProfiles).values({ userId: "9a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b", phone: "(250) 555-0100" })).rejects.toThrow();
  });
});
