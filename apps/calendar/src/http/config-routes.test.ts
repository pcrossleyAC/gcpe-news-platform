import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser, sessionCookie, TEST_RULES } from "../../test/helpers";

const ED = "00000000-0000-4000-8000-000000000301";
const HQ = "00000000-0000-4000-8000-000000000302";

describe("GET /api/config", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    await projectOrg(app, "health");
    await projectOrg(app, "gcpe-hq", { isHq: true });
    await projectUser(app, { id: ED, email: "ed@example.test", displayName: "Sample Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
    await projectUser(app, { id: HQ, email: "hq@example.test", displayName: "Sample HQ Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["gcpe-hq"] });
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
});
