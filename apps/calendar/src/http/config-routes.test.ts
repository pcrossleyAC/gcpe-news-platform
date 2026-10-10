import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { editorRulesOf } from "@gcpe/calendar-contract";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser, sessionCookie, TEST_RULES } from "../../test/helpers";

const ED = "00000000-0000-4000-8000-000000000301";
const HQ = "00000000-0000-4000-8000-000000000302";
const RO = "00000000-0000-4000-8000-000000000303";

describe("GET /api/config", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    await projectOrg(app, "health");
    await projectOrg(app, "gcpe-hq", { isHq: true });
    await projectUser(app, { id: ED, email: "ed@example.test", displayName: "Sample Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
    await projectUser(app, { id: HQ, email: "hq@example.test", displayName: "Sample HQ Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["gcpe-hq"] });
    await projectUser(app, { id: RO, email: "ro@example.test", displayName: "Sample Reader", isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["health"] });
  });
  afterAll(() => tdb.drop());

  it("gives the form its tenant lists and the freeze as it stands for the caller", async () => {
    const frozenApp = createTestApp(tdb.db, { now: () => new Date("2026-11-02T23:30:00Z") });
    const res = await request(frozenApp).get("/api/config").set("cookie", await sessionCookie(ED));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      timeZone: "America/Vancouver",
      freeze: { start: "16:00", end: "17:00", active: true, appliesToYou: true },
      translationsDefault: TEST_RULES.translationsDefault,
      otherCityId: 311,
      releaseCategoryIds: [12, 58],
      lookAheadFieldset: false,
    });
    const hq = await request(frozenApp).get("/api/config").set("cookie", await sessionCookie(HQ));
    expect(hq.body).toMatchObject({ freeze: { active: true, appliesToYou: false }, lookAheadFieldset: true });
    expect(res.body.list).toEqual({ markup: false, corporateQueries: false, lookAheadFilter: false, reviewSelected: false, clearLaStatus: false });
    expect(hq.body.list).toEqual({ markup: false, corporateQueries: false, lookAheadFilter: false, reviewSelected: false, clearLaStatus: true });
  });

  it("gives the editor its slice of the rules, and nothing the browser doesn't need", async () => {
    const app = createTestApp(tdb.db);
    const res = await request(app).get("/api/config").set("cookie", await sessionCookie(ED));
    expect(res.body.rules).toEqual(editorRulesOf(TEST_RULES));
    expect(res.body.rules).not.toHaveProperty("reportBanner");
    expect(res.body.rules).not.toHaveProperty("freeze");
  });

  it("says what this user may do in the editor", async () => {
    const app = createTestApp(tdb.db);
    const get = async (id: string) => (await request(app).get("/api/config").set("cookie", await sessionCookie(id))).body.editor;
    expect(await get(ED)).toEqual({ create: true, relaxRequired: false, useHqPlaceholder: false });
    expect(await get(HQ)).toEqual({ create: true, relaxRequired: true, useHqPlaceholder: true });
    expect(await get(RO)).toEqual({ create: false, relaxRequired: false, useHqPlaceholder: false });
  });
});
