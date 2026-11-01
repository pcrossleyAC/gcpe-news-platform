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
const opts = { prefix: "Approved", nowMs: Date.now() };
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

  // Suite review R8 (fix round 1): a planned release that is still not out stays on the Forecast
  // for 24 hours after its time passes (not cut at midnight); one that went out, or one more
  // than 24 hours past, doesn't.
  it("keeps releases whose time passed in the last 24 hours until they are out; older ones never", async () => {
    const { rows } = await tdb.pool.query<{ now: Date }>("SELECT now() AS now");
    const now = rows[0]!.now.getTime();
    const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
    await planned("Planned an hour ago", hoursAgo(1));
    await planned("Approved, planned 23 hours ago", hoursAgo(23), null, "approved");
    await planned("Failed two hours ago", hoursAgo(2), null, "failed");
    await planned("Published an hour ago", hoursAgo(1), null, "published");
    await planned("Planned 25 hours ago", hoursAgo(25));
    await planned("Planned later", "2031-06-12T17:00:00Z");
    const headlines = (await forecast(tdb.db, null, { page: 1 }, opts)).items.map((i) => (i.kind === "release" ? i.release.headline : ""));
    expect(headlines).toEqual(["Approved, planned 23 hours ago", "Failed two hours ago", "Planned an hour ago", "Planned later"]);
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
