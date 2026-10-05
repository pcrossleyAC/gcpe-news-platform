import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, createScheduledRelease } from "../../test/helpers";
import { newsReleases, releaseLog } from "../db/schema";
import { publishDue } from "../publisher";
import { releaseHolds } from "./release-holds";

async function holdRelease(tdb: TestDatabase, id: string): Promise<void> {
  await tdb.db.execute(sql`UPDATE news_releases SET on_hold = true WHERE id = ${id}`);
}

describe("releaseHolds", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("dry run with nothing on hold changes nothing and lists no releases", async () => {
    const result = await releaseHolds(tdb.db, { confirm: false });
    expect(result).toEqual({ confirmed: false, count: 0, releases: [] });
  });

  it("dry run lists held releases' keys/publish times and flags past-due ones as 'will publish immediately', changing nothing", async () => {
    const future = await createScheduledRelease(tdb.db, {}, new Date(Date.now() + 60 * 60_000));
    await holdRelease(tdb, future.id);
    const past = await createScheduledRelease(tdb.db, {}, new Date(Date.now() - 60_000));
    await holdRelease(tdb, past.id);

    const result = await releaseHolds(tdb.db, { confirm: false });
    expect(result.confirmed).toBe(false);
    if (result.confirmed) throw new Error("unreachable");
    expect(result.count).toBe(2);
    const byKey = new Map(result.releases.map((r) => [r.key, r]));
    expect(byKey.get(future.key!)?.publishesImmediately).toBe(false);
    expect(byKey.get(past.key!)?.publishesImmediately).toBe(true);

    // Nothing changed.
    const rows = await tdb.db.select().from(newsReleases).where(eq(newsReleases.onHold, true));
    expect(rows.map((r) => r.id).sort()).toEqual([future.id, past.id].sort());

    // --confirm clears every held release's hold in one go, bumps version, logs it, and the
    // past-due one then publishes on the publisher's very next tick (not before).
    const beforeVersions = new Map(rows.map((r) => [r.id, r.version]));
    const confirmResult = await releaseHolds(tdb.db, { confirm: true });
    expect(confirmResult).toEqual({ confirmed: true, count: 2 });

    const [futureRow] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.id, future.id));
    const [pastRow] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.id, past.id));
    expect(futureRow!.onHold).toBe(false);
    expect(pastRow!.onHold).toBe(false);
    expect(futureRow!.version).toBe(beforeVersions.get(future.id)! + 1);
    expect(pastRow!.version).toBe(beforeVersions.get(past.id)! + 1);

    for (const id of [future.id, past.id]) {
      const logs = await tdb.db.select().from(releaseLog).where(eq(releaseLog.releaseId, id));
      expect(logs.some((l) => l.text === "Hold released at cutover")).toBe(true);
    }

    // A second dry run now reports nothing on hold.
    const afterConfirm = await releaseHolds(tdb.db, { confirm: false });
    expect(afterConfirm).toEqual({ confirmed: false, count: 0, releases: [] });

    // The publisher publishes the past-due one and leaves the future one alone -- the hold was
    // the only thing keeping it unclaimed, and it wasn't due anyway.
    const result2 = await publishDue({ db: tdb.db, subscribers: [] });
    expect(result2.published).toContain(past.key);
    expect(result2.published).not.toContain(future.key);

    const [pastAfterPublish] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.id, past.id));
    const [futureAfterPublish] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.id, future.id));
    expect(pastAfterPublish!.status).toBe("published");
    expect(futureAfterPublish!.status).toBe("scheduled");
  });
});
