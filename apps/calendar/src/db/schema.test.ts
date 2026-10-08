import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../../test/helpers";
import { activities, activityCategories, categories, cities, commContacts, NEEDS_REVIEW_KEYS, userProfiles } from "./schema";

const USER = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b";

/** Asserts a promise rejects because Postgres refused the row via the named constraint. */
async function expectConstraintViolation(promise: Promise<unknown>, constraint: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ cause: { constraint } });
}

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
    await expectConstraintViolation(
      tdb.db.execute(sql`INSERT INTO activities (title, needs_review) VALUES ('Bad flag', ARRAY['priority'])`),
      "activities_needs_review_check",
    );
  });

  it("refuses an unknown status, HQ status or Look Ahead section", async () => {
    await expectConstraintViolation(tdb.db.execute(sql`INSERT INTO activities (title, status) VALUES ('x', 'archived')`), "activities_status_check");
    await expectConstraintViolation(tdb.db.execute(sql`INSERT INTO activities (title, hq_status) VALUES ('x', 'reviewed')`), "activities_hq_status_check");
    await expectConstraintViolation(tdb.db.execute(sql`INSERT INTO activities (title, hq_section) VALUES ('x', 'consultations')`), "activities_hq_section_check");
  });

  it("refuses text over legacy's column sizes", async () => {
    await expectConstraintViolation(tdb.db.insert(activities).values({ title: "x".repeat(501) }), "activities_title_length");
    await expectConstraintViolation(tdb.db.insert(activities).values({ title: "ok", potentialDates: "x".repeat(71) }), "activities_potential_dates_length");
    await tdb.db.insert(activities).values({ title: "x".repeat(217) }); // the longest legacy title (SV 4.5)
  });

  it("allows one comm contact per user and ministry, ranked 1–6", async () => {
    await tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "health", rank: 1 });
    await expectConstraintViolation(tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "health", rank: 2 }), "comm_contacts_user_ministry_idx");
    await expectConstraintViolation(tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "finance", rank: 7 }), "comm_contacts_rank_check");
  });

  it("keeps legacy's phone (free text to 20 characters) and mobile (empty, or 12 characters of digits and hyphens) rules", async () => {
    await tdb.db.insert(userProfiles).values({ userId: USER, phone: "250-387-1234 x22", mobile: "" });
    await expectConstraintViolation(
      tdb.db.insert(userProfiles).values({ userId: "9a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b", phone: "x".repeat(21) }),
      "user_profiles_phone_length",
    );
    await expectConstraintViolation(
      tdb.db.insert(userProfiles).values({ userId: "7a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6c", mobile: "(250) 555-0100" }),
      "user_profiles_mobile_check",
    );
  });
});
