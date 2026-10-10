import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { FEED_MAX_ITEMS, type FeedPage } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { addEntry, bcAt, FEED_IDS, feedKeyOf, seedFeed } from "../../test/feed-world";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";

const ODD = 20013;
const BULK = 20009;

describe("the updates feed's search (spec addendum §9.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const feed = (who: Who, query: string) => call(app, "get", `/api/updates?${query}`, w.as[who].cookie);
  const search = async (who: Who, keyword: string, rest = "") => {
    const res = await feed(who, `mode=range&keyword=${encodeURIComponent(keyword)}${rest}`);
    expect(res.status, `${who} ${keyword}`).toBe(200);
    const page = res.body as FeedPage;
    return { mode: page.mode, activityId: page.activityId, labels: page.items.map((i) => `${feedKeyOf(i.activityId)} ${i.action}`) };
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    await seedFeed(tdb.db);
    await insertRaw(tdb.db, { id: ODD, title: "Sample 100% _done_ O'Brien \\path COVID-19 2026", details: "Sample odd details" });
    await addEntry(tdb.db, ODD, "created", bcAt("2026-11-02", "12:00"));
    // One more entry than the cap, a second apart, on a day nothing else uses.
    await insertRaw(tdb.db, { id: BULK, title: "Sample bulk", contactMinistryKey: "finance" });
    await tdb.db.execute(sql`
      INSERT INTO activity_changes (activity_id, at, actor_name, action, source)
      SELECT ${BULK}::int, ${"2026-10-01T15:00:00Z"}::timestamptz + n * interval '1 second', 'Sample Bulk', 'updated', 'calendar'
      FROM generate_series(1, ${sql.raw(String(FEED_MAX_ITEMS + 1))}) AS n`);
  });
  afterAll(() => tdb.drop());

  it("matches the activity's title and summary, and who made the change, in any case", async () => {
    expect((await search("editor", "feed b")).labels).toEqual(["B created"]);
    expect((await search("editor", "SAMPLE DETAILS E")).labels).toEqual(["E created"]);
    expect((await search("editor", "reviewer")).labels).toEqual(["A reviewed"]);
  });

  it("searches only what the user can see", async () => {
    expect((await search("financeEditor", "feed b")).labels).toEqual([]);
    expect((await search("hqEditor", "feed b")).labels).toEqual([]);
    expect((await search("hqAdvanced", "feed b")).labels).toEqual(["B created"]);
  });

  it("combines with the dates and the kind of update", async () => {
    expect((await search("hqAdmin", "feed g", "&from=2026-11-03&type=updated")).labels).toEqual(["G updated", "G updated"]);
    expect((await search("hqAdmin", "feed g", "&to=2026-11-02")).labels).toEqual([]);
  });

  it("wildcards, quotes and backslashes match literally", async () => {
    for (const k of ["100%", "%", "_done_", "_", "o'brien", "\\path"]) expect((await search("editor", k)).labels, k).toEqual([`${ODD} created`]);
    expect((await search("editor", "x%y")).labels).toEqual([]);
  });

  it("a keyword naming an activity above 10,000 opens that activity's updates, ignoring the dates and the type", async () => {
    for (const k of [`HLTH-${FEED_IDS.G}`, ` ${FEED_IDS.G} `, `hlth-${FEED_IDS.G}`]) {
      expect(await search("editor", k, "&from=2026-11-01&to=2026-11-01&type=deleted"), k).toEqual({ mode: "activity", activityId: FEED_IDS.G, labels: ["G updated", "G created"] });
    }
  });

  it("a keyword naming an activity they can't see, or none at all, is not found, the same either way", async () => {
    const hidden = await feed("financeEditor", `mode=range&keyword=${FEED_IDS.A}`);
    const missing = await feed("financeEditor", "mode=range&keyword=99999");
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(hidden.body).toEqual(missing.body);
  });

  it("small numbers and hyphenated words are searched as words", async () => {
    expect(await search("editor", "COVID-19")).toEqual({ mode: "range", activityId: null, labels: [`${ODD} created`] });
    expect(await search("editor", "2026")).toEqual({ mode: "range", activityId: null, labels: [`${ODD} created`] });
    expect(await search("editor", "10000")).toEqual({ mode: "range", activityId: null, labels: [] });
  });

  it("answers at most 1,000 entries, newest first, and says when there were more", async () => {
    const day = await feed("hqAdmin", "mode=range&from=2026-10-01&to=2026-10-01");
    const page = day.body as FeedPage;
    expect(page.items).toHaveLength(FEED_MAX_ITEMS);
    expect(page.truncated).toBe(true);
    expect(page.items[0]!.at).toBe("2026-10-01T15:16:41.000Z");
    expect(page.items[FEED_MAX_ITEMS - 1]!.at).toBe("2026-10-01T15:00:02.000Z");
    const one = (await feed("financeEditor", `mode=activity&activity=${BULK}`)).body as FeedPage;
    expect([one.items.length, one.truncated]).toEqual([FEED_MAX_ITEMS, true]);
    expect(((await feed("hqAdmin", "mode=range&from=2026-11-01&to=2026-11-01")).body as FeedPage).truncated).toBe(false);
  });

  it("every value is bounded; nothing is a 500", async () => {
    const bad = [
      "", "mode=since_last_visit", "mode=latest&from=2026-11-01", `mode=range&keyword=${"x".repeat(201)}`, "mode=range&keyword=a%00b",
      "mode=range&from=2026-02-30", "mode=range&from=2026-11-05&to=2026-11-01", "mode=range&type=transferred",
      "mode=activity", "mode=activity&activity=0", "mode=activity&activity=1234567890", "mode=range&from=2026-11-01&from=2026-11-02", "mode=range&sort=at",
    ];
    for (const q of bad) {
      const res = await feed("editor", q);
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBe("invalid request");
    }
    expect((await feed("editor", `mode=range&keyword=${"x".repeat(200)}`)).status).toBe(200);
  });
});
