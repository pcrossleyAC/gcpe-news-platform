import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { listManualReviews, manualReviewInputSchema, recordManualReview } from "./manual-reviews";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("manual reviews service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE manual_reviews");
  });

  it("records a review and lists it", async () => {
    await recordManualReview(tdb.db, { pageId: "government-terms", hash: HASH_A }, "Pat");
    const rows = await listManualReviews(tdb.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pageId: "government-terms", hash: HASH_A, reviewedBy: "Pat" });
    expect(new Date(rows[0]!.reviewedAt).getTime()).toBeGreaterThan(0);
  });

  it("is idempotent, and a second admin's review of the same version keeps the first reviewer and time", async () => {
    await recordManualReview(tdb.db, { pageId: "government-terms", hash: HASH_A }, "Pat");
    const [first] = await listManualReviews(tdb.db);
    await recordManualReview(tdb.db, { pageId: "government-terms", hash: HASH_A }, "Sam");
    const rows = await listManualReviews(tdb.db);
    expect(rows).toEqual([first]);
    expect(rows[0]!.reviewedBy).toBe("Pat");
  });

  it("keeps a separate review for each version of a page", async () => {
    await recordManualReview(tdb.db, { pageId: "government-terms", hash: HASH_A }, "Pat");
    await recordManualReview(tdb.db, { pageId: "government-terms", hash: HASH_B }, "Sam");
    expect((await listManualReviews(tdb.db)).map((r) => [r.hash, r.reviewedBy]).sort()).toEqual([
      [HASH_A, "Pat"],
      [HASH_B, "Sam"],
    ]);
  });

  describe("input shape", () => {
    const ok = { pageId: "government-terms", hash: HASH_A };
    it("accepts a kebab-case page id and a 64-character lowercase hex hash", () => {
      expect(manualReviewInputSchema.parse(ok)).toEqual(ok);
      expect(manualReviewInputSchema.safeParse({ ...ok, pageId: "a" }).success).toBe(true);
      expect(manualReviewInputSchema.safeParse({ ...ok, pageId: "a".repeat(100) }).success).toBe(true);
    });
    it.each([
      ["empty page id", { ...ok, pageId: "" }],
      ["101-character page id", { ...ok, pageId: "a".repeat(101) }],
      ["upper case page id", { ...ok, pageId: "Government-Terms" }],
      ["page id with a slash", { ...ok, pageId: "a/b" }],
      ["page id with a double hyphen", { ...ok, pageId: "a--b" }],
      ["page id ending in a hyphen", { ...ok, pageId: "a-" }],
      ["short hash", { ...ok, hash: "a".repeat(63) }],
      ["long hash", { ...ok, hash: "a".repeat(65) }],
      ["upper case hash", { ...ok, hash: "A".repeat(64) }],
      ["non-hex hash", { ...ok, hash: "g".repeat(64) }],
      ["extra field", { ...ok, reviewedBy: "Eve" }],
      ["missing hash", { pageId: "x" }],
    ])("rejects %s", (_name, body) => {
      expect(manualReviewInputSchema.safeParse(body).success).toBe(false);
    });
  });
});
