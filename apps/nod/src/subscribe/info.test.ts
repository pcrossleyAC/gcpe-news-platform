import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { PreferencesError, infoFor, normaliseEmail, subscriberInfoSchema, toPrefs } from "./info";

describe("SubscriberInfo", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES
      ('ministries:health', 'ministries', 'health', 'Health'),
      ('ministries:old', 'ministries', 'old', 'Old'),
      ('media-distribution-lists:budget', 'media-distribution-lists', 'budget', 'Budget');
      UPDATE lists SET active = false WHERE list_key = 'ministries:old';`);
  });
  afterAll(async () => tdb.drop());

  const info = (over: Record<string, unknown>) =>
    subscriberInfoSchema.parse({ emailAddress: "pat@example.test", subscribedCategories: {}, isAllNews: false, isAsItHappens: true, isDailyDigest: false, ...over });

  it("normalises case and spaces", () => {
    expect(normaliseEmail("  Pat@Example.TEST ")).toBe("pat@example.test");
  });

  it("maps categories to list keys and all-news to *", async () => {
    expect(await toPrefs(tdb.db, info({ subscribedCategories: { ministries: ["Health"] } }))).toEqual({
      email: "pat@example.test",
      prefs: { allNews: false, listKeys: ["ministries:health"], asItHappens: true, digest: false },
    });
    expect((await toPrefs(tdb.db, info({ isAllNews: true }))).prefs.listKeys).toEqual(["*"]);
  });

  it("drops unknown and media lists", async () => {
    const r = await toPrefs(tdb.db, info({ subscribedCategories: { ministries: ["health", "old", "nope"], "media-distribution-lists": ["budget"] } }));
    expect(r.prefs.listKeys).toEqual(["ministries:health"]);
  });

  it("rejects empty preferences", async () => {
    await expect(toPrefs(tdb.db, info({ subscribedCategories: { ministries: ["nope"] } }))).rejects.toBeInstanceOf(PreferencesError);
    await expect(toPrefs(tdb.db, info({ isAllNews: true, isAsItHappens: false, isDailyDigest: false }))).rejects.toBeInstanceOf(PreferencesError);
  });

  it("rejects an invalid or over-long email", () => {
    expect(subscriberInfoSchema.safeParse({ emailAddress: "not-an-email" }).success).toBe(false);
    expect(subscriberInfoSchema.safeParse({ emailAddress: `${"a".repeat(145)}@x.test` }).success).toBe(false);
  });

  it("infoFor returns legacy-shaped preferences", async () => {
    await tdb.db.execute(sql`
      INSERT INTO subscribers (id, email, manage_token, status, as_it_happens, digest) VALUES ('00000000-0000-0000-0000-0000000000b1', 'info@example.test', 'tb1', 'active', false, true);
      INSERT INTO subscriptions (subscriber_id, list_key) VALUES ('00000000-0000-0000-0000-0000000000b1', 'ministries:health');`);
    expect(await infoFor(tdb.db, "00000000-0000-0000-0000-0000000000b1")).toEqual({
      emailAddress: "info@example.test",
      subscribedCategories: { ministries: ["health"] },
      isAllNews: false,
      isAsItHappens: false,
      isDailyDigest: true,
      isAdminRegistration: false,
      notifyIfNewCategories: false,
      expiredLinkOrUnverifiedEmail: false,
    });
  });
});
