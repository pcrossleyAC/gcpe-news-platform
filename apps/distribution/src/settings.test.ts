import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../test/helpers";
import { getSettings, setPaused } from "./settings";

describe("Distribution settings", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.db.execute(sql`UPDATE distribution_settings SET paused = false`);
  });

  it("getSettings reflects the singleton row, seeded unpaused", async () => {
    expect(await getSettings(tdb.db)).toEqual({ paused: false });
    await tdb.db.execute(sql`UPDATE distribution_settings SET paused = true`);
    expect(await getSettings(tdb.db)).toEqual({ paused: true });
  });

  it("setPaused(true) pauses and reports changed: true; a repeat pause reports changed: false", async () => {
    const first = await setPaused(tdb.db, true);
    expect(first).toEqual({ paused: true, changed: true });
    expect(await getSettings(tdb.db)).toEqual({ paused: true });

    const again = await setPaused(tdb.db, true);
    expect(again).toEqual({ paused: true, changed: false });
  });

  it("setPaused(false) resumes and reports changed: true; a repeat resume reports changed: false", async () => {
    await setPaused(tdb.db, true);

    const resumed = await setPaused(tdb.db, false);
    expect(resumed).toEqual({ paused: false, changed: true });
    expect(await getSettings(tdb.db)).toEqual({ paused: false });

    const again = await setPaused(tdb.db, false);
    expect(again).toEqual({ paused: false, changed: false });
  });
});
