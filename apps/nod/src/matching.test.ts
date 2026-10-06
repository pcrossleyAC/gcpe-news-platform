import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { matchesItem } from "./matching";

/** matchesItem is pure SQL (ANY/unnest/LIKE), so it's exercised against a real Postgres
 * connection rather than unit-tested in isolation. */
describe("matchesItem", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());

  async function matches(listKey: string, itemListKeys: string[]): Promise<boolean> {
    const r = await tdb.db.execute<{ matched: boolean }>(sql`
      SELECT ${matchesItem(sql`${listKey}::text`, sql`${sql.param(itemListKeys)}::text[]`)} AS matched`);
    return r.rows[0]!.matched;
  }

  it("'*' matches an item carrying a ministries key", async () => {
    expect(await matches("*", ["ministries:health"])).toBe(true);
  });

  it("'*' does not match an item with only non-ministries keys", async () => {
    expect(await matches("*", ["emergency:alerts"])).toBe(false);
  });

  it("an exact list key matches an item listing it", async () => {
    expect(await matches("sectors:mining", ["sectors:mining", "ministries:energy"])).toBe(true);
  });

  it("nothing matches an item with empty keys", async () => {
    expect(await matches("*", [])).toBe(false);
    expect(await matches("sectors:mining", [])).toBe(false);
  });
});
