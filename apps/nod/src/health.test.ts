import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { digestRuns, nodSettings } from "./db/schema";
import { nodHealth } from "./health";

// Suite review O2.1: what NoD tells /stack/health about its background work.
describe("nodHealth", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.delete(digestRuns);
    await tdb.db.update(nodSettings).set({ emergencyFeedCheckedAt: null, emergencyFeedResult: null, mediaSyncSince: null, mediaSyncResult: null }).where(eq(nodSettings.id, 1));
  });

  it("reports nothing run yet as nulls", async () => {
    expect(await nodHealth(tdb.db, { emergencyFeedOn: true, mediaSyncOn: true, sendLastOkAt: () => null })).toEqual({
      digestMinutesAgo: null,
      emergencyFeed: { on: true, minutesSinceLastCheck: null, lastCheckOk: null },
      mediaSync: { on: true, minutesSinceLastSuccess: null, lastRunFailed: false },
      sendLoopMinutesAgo: null,
    });
  });

  it("reports minutes since the last digest, feed check, media sync and send", async () => {
    await tdb.db.insert(digestRuns).values({ cutoff: sql`now() - interval '3 hours'`, windowStart: sql`now() - interval '27 hours'`, ranAt: sql`now() - interval '3 hours'` });
    await tdb.db
      .update(nodSettings)
      .set({
        emergencyFeedCheckedAt: sql`now() - interval '7 minutes'`,
        emergencyFeedResult: { at: new Date().toISOString(), ok: false, error: "HTTP 500" },
        mediaSyncSince: sql`now() - interval '2 hours'`,
        mediaSyncResult: { error: "timeout" },
      })
      .where(eq(nodSettings.id, 1));
    const h = await nodHealth(tdb.db, { emergencyFeedOn: true, mediaSyncOn: true, sendLastOkAt: () => Date.now() - 4 * 60_000 });
    expect(h).toEqual({
      digestMinutesAgo: 180,
      emergencyFeed: { on: true, minutesSinceLastCheck: 7, lastCheckOk: false },
      mediaSync: { on: true, minutesSinceLastSuccess: 120, lastRunFailed: true },
      sendLoopMinutesAgo: 4,
    });
  });

  it("says a switched-off feed or Media Hub is off", async () => {
    const h = await nodHealth(tdb.db, { emergencyFeedOn: false, mediaSyncOn: false, sendLastOkAt: () => null });
    expect(h.emergencyFeed.on).toBe(false);
    expect(h.mediaSync.on).toBe(false);
  });
});
