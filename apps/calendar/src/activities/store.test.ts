import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../../test/helpers";
import { inReadSnapshot } from "./store";

describe("inReadSnapshot", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());

  it("runs every read in one repeatable-read, read-only transaction", async () => {
    const settings = await inReadSnapshot(tdb.db, async (tx) => {
      const r = await tx.execute<{ iso: string; ro: string }>(sql`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro`);
      return r.rows[0];
    });
    expect(settings).toEqual({ iso: "repeatable read", ro: "on" });
  });

  it("refuses a write", async () => {
    await expect(inReadSnapshot(tdb.db, (tx) => tx.execute(sql`INSERT INTO keywords (name) VALUES ('Sample snapshot write')`))).rejects.toThrow();
  });
});
