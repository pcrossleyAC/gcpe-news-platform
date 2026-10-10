import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectUser, sessionCookie } from "../../test/helpers";
import { call, seedWorld, type World } from "../../test/world";

describe("GET /api/editor-options (spec addendum §8.2)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const get = (cookie: string) => call(app, "get", "/api/editor-options", cookie);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("lists every lookup row with its active flag, so an activity's inactive value can still be shown", async () => {
    const res = await get(w.as.editor.cookie);
    expect(res.status).toBe(200);
    expect(res.body.categories).toContainEqual({ id: w.cat.hqPlaceholder, name: "Sample HQ placeholder", isActive: false });
    expect(res.body.categories).toContainEqual({ id: w.cat.plain, name: "Sample plain category", isActive: true });
    expect(res.body.cities).toContainEqual({ id: w.city.retired, name: "Sample Retired City", isActive: false });
    expect(res.body.commMaterials).toContainEqual({ id: w.commMaterial.retired, name: "Sample retired material", isActive: false });
    expect(res.body.initiatives).toEqual([{ id: 1, name: "Sample initiative", isActive: true, shortName: "SI" }]);
    for (const k of ["eventPlanners", "representatives", "keywords", "distributions", "origins", "premierRequested", "videographers"]) {
      expect(res.body[k].length, k).toBeGreaterThan(0);
    }
  });

  it("lists every ministry and every term, inactive ones flagged", async () => {
    const res = await get(w.as.editor.cookie);
    expect(res.body.ministries).toContainEqual({ key: "health", abbreviation: "HLTH", name: "Sample Health", isActive: true });
    expect(res.body.ministries).toContainEqual({ key: "retired", abbreviation: "RET", name: "Sample Retired", isActive: false });
    expect(res.body.tags).toEqual(expect.arrayContaining([
      { key: "sample-tag", name: "Sample tag sample-tag", isActive: true },
      { key: "retired-tag", name: "Sample tag retired-tag", isActive: false },
    ]));
    expect(res.body.sectors).toEqual([{ key: "sample-sector", name: "Sample sector sample-sector", isActive: true }]);
    expect(res.body.themes).toEqual([{ key: "sample-theme", name: "Sample theme sample-theme", isActive: true }]);
  });

  it("lists every comm contact; one is inactive when the contact or its person is", async () => {
    const res = await get(w.as.editor.cookie);
    expect(res.body.commContacts).toContainEqual({ id: w.contact.editorHealth, ministryKey: "health", name: "Robin Staff", rank: 4, isActive: true });
    expect(res.body.commContacts).toContainEqual({ id: w.contact.retiredHealth, ministryKey: "health", name: "Sample Advanced", rank: 4, isActive: false });
    await projectUser(app, { id: w.as.financeEditor.id, email: "financeEditor@example.test", displayName: "Kim Finance", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["finance"] });
    const after = await get(w.as.editor.cookie);
    expect(after.body.commContacts).toContainEqual({ id: w.contact.financeEditor, ministryKey: "finance", name: "Kim Finance", rank: 4, isActive: false });
  });

  it("any Calendar role reads it; a user without one is refused", async () => {
    expect((await get(w.as.readOnly.cookie)).status).toBe(200);
    const none = "00000000-0000-4000-8000-000000000499";
    await projectUser(app, { id: none, email: "none@example.test", displayName: "Sample Nobody", isActive: true, calendarRole: null, organizationKeys: ["health"] });
    expect((await get(await sessionCookie(none))).status).toBe(403);
  });
});
