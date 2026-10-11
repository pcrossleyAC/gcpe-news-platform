import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb } from "../../test/helpers";
import { assertSearchLanguage, searchVectorLanguage } from "./language";

describe("the search language check", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("reads english from the migrated column, and passes for english", async () => {
    expect(await searchVectorLanguage(tdb.db)).toBe("english");
    await expect(assertSearchLanguage(tdb.db, "english")).resolves.toBeUndefined();
  });

  it("refuses another language, naming both", async () => {
    await expect(assertSearchLanguage(tdb.db, "french")).rejects.toThrow(/search\.language is "french" but posts\.search_vector uses "english"/);
  });

  it("refuses when the column is missing", async () => {
    const other = await createNewsTestDb();
    try {
      await other.pool.query("ALTER TABLE posts DROP COLUMN search_vector");
      expect(await searchVectorLanguage(other.db)).toBeNull();
      await expect(assertSearchLanguage(other.db, "english")).rejects.toThrow(/uses "\(none\)"/);
    } finally {
      await other.drop();
    }
  });
});
