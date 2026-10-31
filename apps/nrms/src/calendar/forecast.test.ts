import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import type { Viewer } from "@gcpe/calendar-contract";
import type { ForecastItem } from "@gcpe/nrms-contract";
import { createNrmsTestDb, editor, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { calendarViewers, organizations } from "../db/schema";
import { createRelease } from "../releases/service";
import { forecast } from "./forecast";

const HQ: Viewer = { level: 1, isHq: true, ministryKeys: ["gcpe-hq"] };
const HEALTH: Viewer = { level: 2, isHq: false, ministryKeys: ["health"] };
const opts = { prefix: "Approved", nowMs: Date.now(), timeZone: "America/Vancouver" };
/** Each item as "release:<headline>" or "activity:<id>", with its time. */
const outline = (items: ForecastItem[]) => items.map((i) => (i.kind === "release" ? `release:${i.release.headline}@${i.at}` : `activity:${i.activity.activityId}@${i.at}`));

describe("the Forecast tab (spec addendum §11, ReleasesModel.cs:144-230)", () => {
  let tdb: TestDatabase;
  /** A release planned (draft) for `at`, optionally linked to an activity. */
  const planned = async (headline: string, at: string, activityId: number | null = null, status = "draft") => {
    const v = await createRelease(tdb.db, { ...sampleCreate, headline, activityId }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET publish_at = ${at}::timestamptz, status = ${status} WHERE id = ${v.id}`);
    return v;
  };

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(organizations).values({ key: "education", displayName: "Education", abbreviation: "EDUC" });
  });
  afterAll(() => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, calendar_activities CASCADE");
  });

  it("lists every non-deleted release from now on, and each eligible activity at its release time or else its start, by time", async () => {
    await planned("Release on the tenth", "2031-06-10T17:00:00Z", null, "scheduled");
    await planned("Release on the twelfth", "2031-06-12T17:00:00Z");
    await planned("Release in the past", "2020-06-12T17:00:00Z");
    await planned("Deleted release", "2031-06-12T18:00:00Z", null, "deleted");
    await seedActivity(tdb.db, 6001, { title: "Activity on the eleventh" });
    await seedActivity(tdb.db, 6002, { startAt: new Date("2031-06-13T17:00:00Z"), endAt: null, nrAt: new Date("2031-06-09T17:00:00Z") });
    const page = await forecast(tdb.db, HQ, { page: 1 }, opts);
    expect(outline(page.items)).toEqual([
      "activity:6002@2031-06-09T17:00:00.000Z",
      "release:Release on the tenth@2031-06-10T17:00:00.000Z",
      "activity:6001@2031-06-11T17:00:00.000Z",
      "release:Release on the twelfth@2031-06-12T17:00:00.000Z",
    ]);
    expect(page).toMatchObject({ total: 4, page: 1, pageSize: 25, calendarActivities: true });
    expect(page.items[2]).toEqual({
      kind: "activity", at: "2031-06-11T17:00:00.000Z",
      activity: { activityId: 6001, title: "Activity on the eleventh", details: "Sample details.", ministryName: "Health", categoryNames: ["Approved Event"], location: "Victoria" },
    });
    expect(page.items[1]).toMatchObject({ kind: "release", release: { status: "scheduled", statusText: expect.any(String), activityId: null } });
  });

  // Suite review R8: a planned release that is still not out stays on the Forecast for the rest of
  // its day after its time passes (the morning check's gap that matters most); one that went out,
  // or one from an earlier day, doesn't.
  it("keeps today's releases whose time has passed until they are out; earlier days' never", async () => {
    const { rows } = await tdb.pool.query<{ start: Date; now: Date }>("SELECT (date_trunc('day', now() AT TIME ZONE 'America/Vancouver') AT TIME ZONE 'America/Vancouver') AS start, now() AS now");
    const start = rows[0]!.start.getTime();
    const earlierToday = new Date(start + (rows[0]!.now.getTime() - start) / 2).toISOString();
    const yesterday = new Date(start - 3600_000).toISOString();
    await planned("Planned earlier today", earlierToday);
    await planned("Approved, planned earlier today", earlierToday, null, "approved");
    await planned("Failed earlier today", earlierToday, null, "failed");
    await planned("Published earlier today", earlierToday, null, "published");
    await planned("Planned yesterday", yesterday);
    await planned("Planned later", "2031-06-12T17:00:00Z");
    const at = new Date(earlierToday).toISOString();
    expect(outline((await forecast(tdb.db, null, { page: 1 }, opts)).items).sort()).toEqual(
      [`release:Approved, planned earlier today@${at}`, `release:Failed earlier today@${at}`, `release:Planned earlier today@${at}`, "release:Planned later@2031-06-12T17:00:00.000Z"].sort(),
    );
  });

  it("leaves out confidential, deleted, unconfirmed, started, not \"Approved\", and activities a future release is linked to", async () => {
    const confidentialRow = { isConfidential: true, title: null, details: null, startAt: null, endAt: null, isAllDay: null, isConfirmed: null, contactMinistryKey: null, cityName: null, categoryNames: [], sectorKeys: [] };
    await seedActivity(tdb.db, 6101, confidentialRow);
    await seedActivity(tdb.db, 6102, { isDeleted: true });
    await seedActivity(tdb.db, 6103, { isConfirmed: false });
    await seedActivity(tdb.db, 6104, { startAt: new Date("2020-06-11T17:00:00Z") });
    await seedActivity(tdb.db, 6105, { categoryNames: ["Proposed Event"] });
    await seedActivity(tdb.db, 6106);
    await seedActivity(tdb.db, 6107);
    await planned("Linked, in the future", "2031-06-20T17:00:00Z", 6106);
    // Legacy hides an activity only behind a future release: one already out leaves it listed (Q65).
    await planned("Linked, already out", "2020-06-20T17:00:00Z", 6107, "published");
    expect(outline((await forecast(tdb.db, HQ, { page: 1 }, opts)).items)).toEqual([
      "activity:6107@2031-06-11T17:00:00.000Z",
      "release:Linked, in the future@2031-06-20T17:00:00.000Z",
    ]);
  });

  it("shows activities only as the Calendar would: own and shared ministries, or HQ; none without Calendar access", async () => {
    await seedActivity(tdb.db, 6201, { contactMinistryKey: "health" });
    await seedActivity(tdb.db, 6202, { contactMinistryKey: "education", sharedMinistryKeys: ["health"] });
    await seedActivity(tdb.db, 6203, { contactMinistryKey: "education" });
    await planned("A release", "2031-06-30T17:00:00Z");
    const ids = async (v: Viewer | null) => (await forecast(tdb.db, v, { page: 1 }, opts)).items.map((i) => (i.kind === "activity" ? i.activity.activityId : "release"));
    expect(await ids(HEALTH)).toEqual([6201, 6202, "release"]);
    expect(await ids(HQ)).toEqual([6201, 6202, 6203, "release"]);
    const none = await forecast(tdb.db, null, { page: 1 }, opts);
    expect(none).toMatchObject({ total: 1, calendarActivities: false });
    expect(await ids({ ...HQ, level: 0 })).toEqual(["release"]);
  });

  it("a release and an activity at the same minute: the release first, as legacy's concatenation sorted", async () => {
    await seedActivity(tdb.db, 6301);
    await planned("Same minute", "2031-06-11T17:00:00Z");
    expect(outline((await forecast(tdb.db, HQ, { page: 1 }, opts)).items)).toEqual(["release:Same minute@2031-06-11T17:00:00.000Z", "activity:6301@2031-06-11T17:00:00.000Z"]);
  });

  it("pages 25 at a time", async () => {
    for (let i = 0; i < 30; i++) await seedActivity(tdb.db, 6400 + i, { startAt: new Date(Date.UTC(2031, 5, 1, 17, i)) });
    const second = await forecast(tdb.db, HQ, { page: 2 }, opts);
    expect(second).toMatchObject({ total: 30, page: 2, pageSize: 25 });
    expect(second.items.map((i) => (i.kind === "activity" ? i.activity.activityId : 0))).toEqual([6425, 6426, 6427, 6428, 6429]);
  });

  it("with no Calendar settings on the site, lists releases only", async () => {
    await seedActivity(tdb.db, 6501);
    expect((await forecast(tdb.db, HQ, { page: 1 }, { ...opts, prefix: null })).items).toEqual([]);
  });

  it("GET /forecast: any NRMS reader; the viewer is the session's; a bad page is a 400", async () => {
    const secret = "z".repeat(40) + "-forecast";
    const app = createApp({ db: tdb.db, auth: { session: { secret } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, forecastCategoryPrefix: "Approved" });
    const id = "00000000-0000-4000-8000-000000000801";
    await tdb.db.insert(calendarViewers).values({ userId: id, isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["health"] }).onConflictDoNothing();
    const cookie = async (roles: string[]) => `gcpe_session=${(await mintSession(secret, { id, name: "Sample Viewer", email: "viewer@example.test", roles })).token}`;
    await seedActivity(tdb.db, 6601);
    const res = await request(app).get("/api/forecast?page=1").set("cookie", await cookie(["NRMS.Viewer"]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, calendarActivities: true, items: [{ kind: "activity", activity: { activityId: 6601 } }] });
    expect((await request(app).get("/api/forecast?page=0").set("cookie", await cookie(["NRMS.Viewer"]))).status).toBe(400);
    expect((await request(app).get("/api/forecast").set("cookie", await cookie(["Core.Admin"]))).status).toBe(403);
  });
});
