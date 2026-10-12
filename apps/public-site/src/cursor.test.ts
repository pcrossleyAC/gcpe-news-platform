import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { readCursor, saveCursor } from "./cursor";

describe("cursor", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_state"); });

  it("is null on a fresh database", async () => {
    expect(await readCursor(tdb.db)).toBeNull();
  });

  it("saveCursor then readCursor returns what was saved", async () => {
    await saveCursor(tdb.db, 42);
    expect(await readCursor(tdb.db)).toBe(42);
  });

  it("saving again overwrites the stored cursor", async () => {
    await saveCursor(tdb.db, 42);
    await saveCursor(tdb.db, 99);
    expect(await readCursor(tdb.db)).toBe(99);
  });

  it("the check constraint keeps one row", async () => {
    await saveCursor(tdb.db, 1);
    await saveCursor(tdb.db, 2);
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM site_state");
    expect(rows[0].n).toBe(1);
  });
});
