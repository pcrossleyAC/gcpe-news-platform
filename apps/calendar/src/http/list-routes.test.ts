import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintLocalToken } from "@gcpe/auth";
import { createCalendarTestDb, createTestApp, EVENT_SECRETS, SESSION_SECRET, TEST_RULES } from "../../test/helpers";
import { call, insertRaw, seedWorld, validInput, type World } from "../../test/world";
import { createApp } from "../app";
import { activityCategories, favourites, userProfiles } from "../db/schema";

const listUrl = (q: object | string, offset?: string) =>
  `/api/list?q=${encodeURIComponent(typeof q === "string" ? q : JSON.stringify(q))}${offset === undefined ? "" : `&offset=${offset}`}`;

describe("GET /api/list and /api/list/options (spec addendum §8.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("returns the page's rows with every column the list and the export show", async () => {
    await tdb.db.insert(userProfiles).values({ userId: w.as.editor.id, phone: "250-555-0101" });
    const created = await call(app, "post", "/api/activities", w.as.hqAdmin.cookie, validInput(w, {
      title: "Sample listed", startDate: "2044-02-03", endDate: "2044-02-03", keywordNames: ["Sample kept keyword"], commMaterialIds: [w.commMaterial.newsRelease],
      premierRequestedId: w.ids.premierYes, governmentRepresentativeId: w.ids.representative, eventPlannerId: w.ids.planner, leadOrganization: "Sample Org",
      venue: "Sample Hall", translations: ["Sample language A"], sharedWithKeys: ["finance"],
    }));
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    await tdb.db.insert(favourites).values([{ userId: w.as.editor.id, activityId: id }, { userId: w.as.admin.id, activityId: id }]);
    const res = await call(app, "get", listUrl({ filter: { from: "2044-02-01", to: "2044-02-28" } }), w.as.editor.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, offset: 0 });
    expect(res.body.rows[0]).toMatchObject({
      id, version: 1, ministryKey: "health", ministryAbbreviation: "HLTH", status: "new", hqStatus: null, isDeleted: false,
      isWatched: true, watcherNames: ["Robin Staff", "Sample Admin"], isShared: true, hasRelease: false,
      lastUpdatedByName: "Sample HQ Admin", keywords: ["Sample kept keyword"], isAllDay: false, isConfirmed: true,
      title: "Sample listed", details: "Sample summary", significance: "Sample significance", schedule: "Sample scheduling",
      categories: ["Sample plain category"], isIssue: false, isConfidential: false, commMaterials: ["Sample news release"],
      premierRequested: "Sample yes", leadOrganization: "Sample Org", translations: ["Sample language A"], city: "Sample City", venue: "Sample Hall",
      commContact: { name: "Robin Staff", phone: "250-555-0101" }, governmentRepresentative: "Sample Representative", eventPlanner: "Sample Planner",
      needsReview: [],
    });
  });

  it("shows Other City for the city \"Other…\", and the review markup only to HQ Administrators", async () => {
    const id = await insertRaw(tdb.db, { startAt: new Date("2044-03-03T17:00:00Z"), endAt: new Date("2044-03-03T18:00:00Z"), cityId: w.city.other, otherCity: "Sample Cove", needsReview: ["title"], status: "changed" });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
    const q = { filter: { from: "2044-03-01", to: "2044-03-31" } };
    const admin = await call(app, "get", listUrl(q), w.as.hqAdmin.cookie);
    expect(admin.body.rows[0]).toMatchObject({ id, city: "Sample Cove", needsReview: ["title"] });
    const advanced = await call(app, "get", listUrl(q), w.as.hqAdvanced.cookie);
    expect(advanced.body.rows[0]).toMatchObject({ id, needsReview: [] });
  });

  it("a malformed list request is 400, never 500", async () => {
    const bad = [
      "/api/list",
      listUrl("{not json"),
      listUrl("x".repeat(8001)),
      listUrl({ filter: { extra: 1 } }),
      listUrl({ filter: { categoryId: 2_147_483_648 } }),
      listUrl({ filter: { quickSearch: "a\u0000b" } }),
      listUrl({ filter: { from: "2300-01-01" } }),
      listUrl({ filter: { from: "2026-11-05", to: "2026-11-01" } }),
      listUrl({ sort: "premier" }),
      listUrl({}, "-1"),
      listUrl({}, "1e3"),
      listUrl({}, "abc"),
      listUrl({}, "99999999"),
      `${listUrl({})}&q=${encodeURIComponent("{}")}`,
      `${listUrl({})}&extra=1`,
      `/api/list?q[filter]=1`,
    ];
    for (const url of bad) expect((await call(app, "get", url, w.as.editor.cookie)).status, url).toBe(400);
  });

  it("refuses a corporate query or the Look Ahead filter below HQ Advanced with 403", async () => {
    expect((await call(app, "get", listUrl({ corporate: { days: 8, statuses: ["new"] } }), w.as.hqEditor.cookie)).status).toBe(403);
    expect((await call(app, "get", listUrl({ lookAhead: "look_ahead_only" }), w.as.admin.cookie)).status).toBe(403);
    expect((await call(app, "get", listUrl({ corporate: { days: 8, statuses: ["new"] } }), w.as.hqAdvanced.cookie)).status).toBe(200);
  });

  it("gives a bearer token nothing, even one for a projected user", async () => {
    const local = "calendar-local-bearer-secret-0123456789ab";
    const withLocal = createApp({ db: tdb.db, auth: { session: { secret: SESSION_SECRET }, local: { secret: local } }, eventSecrets: EVENT_SECRETS, rules: TEST_RULES });
    const token = await mintLocalToken({ secret: local, subject: w.as.hqAdmin.id, roles: ["Calendar.SysAdmin"] });
    for (const path of [listUrl({}), "/api/list/options"]) {
      expect((await request(withLocal).get(path).set("authorization", `Bearer ${token}`)).status).toBe(403);
    }
  });

  it("options: active lookups; a ministry user's own ministries and comm-contact people, every active one for HQ", async () => {
    const mine = (await call(app, "get", "/api/list/options", w.as.editor.cookie)).body;
    expect(mine.ministries).toEqual([{ key: "health", abbreviation: "HLTH", name: "Sample Health" }]);
    expect(mine.commContacts).toEqual([{ userId: w.as.editor.id, name: "Robin Staff" }, { userId: w.as.admin.id, name: "Sample Admin" }]);
    expect(mine.categories.map((c: { id: number }) => c.id)).not.toContain(w.cat.retired);
    expect(mine.categories.map((c: { id: number }) => c.id)).toContain(w.cat.awareness);
    expect(mine.keywords).toEqual(expect.arrayContaining([{ id: w.ids.keptKeyword, name: "Sample kept keyword" }]));
    for (const k of ["representatives", "initiatives", "premierRequested", "distributions"]) expect(mine[k].length).toBeGreaterThan(0);
    const hq = (await call(app, "get", "/api/list/options", w.as.hqEditor.cookie)).body;
    expect(hq.ministries.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(["health", "finance", "gcpe-hq"]));
    expect(hq.ministries.map((m: { key: string }) => m.key)).not.toContain("retired");
    expect(hq.commContacts.map((c: { userId: string }) => c.userId)).toEqual(expect.arrayContaining([w.as.financeEditor.id]));
    // The inactive comm contact's person isn't offered.
    expect(hq.commContacts.map((c: { userId: string }) => c.userId)).not.toContain(w.as.advanced.id);
  });
});
