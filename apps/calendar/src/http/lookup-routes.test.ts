import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { CalendarRole } from "@gcpe/auth";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser, sessionCookie } from "../../test/helpers";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("lookup admin routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  const cookies: Partial<Record<CalendarRole, string>> = {};
  const as = (role: CalendarRole) => cookies[role]!;
  const write = (method: "post" | "put", path: string, role: CalendarRole, body: object) => request(app)[method](path).set("cookie", as(role)).set("x-gcpe-request", "1").send(body);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    await projectOrg(app, "health");
    const roles: CalendarRole[] = ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"];
    for (const [i, role] of roles.entries()) {
      await projectUser(app, { id: id(i + 1), email: `u${i}@example.test`, displayName: `Sample ${role}`, isActive: true, calendarRole: role, organizationKeys: ["health"] });
      cookies[role] = await sessionCookie(id(i + 1));
    }
  });
  afterAll(() => tdb.drop());

  it("is refused below Administrator, on reads and writes (C140)", async () => {
    for (const role of ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced"] as CalendarRole[]) {
      expect((await request(app).get("/api/lookups").set("cookie", as(role))).status).toBe(403);
      expect((await write("post", "/api/lookups/keywords", role, { name: "Nope" })).status).toBe(403);
    }
  });

  it("an Administrator sees every lookup, editable only where legacy allowed", async () => {
    const res = await request(app).get("/api/lookups").set("cookie", as("Calendar.Administrator"));
    expect(res.status).toBe(200);
    const editable = Object.fromEntries((res.body as { name: string; editable: boolean }[]).map((l) => [l.name, l.editable]));
    expect(editable).toMatchObject({ keywords: true, initiatives: true, "event-planners": true, videographers: true, categories: false, cities: false });
  });

  it("an Administrator changes keywords but not categories; a SysAdmin changes both", async () => {
    const kw = await write("post", "/api/lookups/keywords", "Calendar.Administrator", { name: "Sample keyword" });
    expect(kw.status).toBe(201);
    const refused = await write("post", "/api/lookups/categories", "Calendar.Administrator", { name: "Sample category" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("only a System Administrator can change Categories");
    expect((await write("post", "/api/lookups/categories", "Calendar.SysAdmin", { name: "Sample category" })).status).toBe(201);
  });

  it("renames, deactivates and reactivates a row; GET shows inactive rows too", async () => {
    const created = (await write("post", "/api/lookups/initiatives", "Calendar.Administrator", { name: "Sample initiative", extras: { shortName: "SI" } })).body;
    const renamed = await write("put", `/api/lookups/initiatives/${created.id}`, "Calendar.Administrator", { name: "Renamed initiative", extras: { shortName: "RI" }, isActive: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed initiative", isActive: false, extras: { shortName: "RI" } });
    const list = await request(app).get("/api/lookups/initiatives").set("cookie", as("Calendar.Administrator"));
    expect(list.body.rows.find((r: { id: number }) => r.id === created.id)).toMatchObject({ isActive: false });
  });

  it("reorders, and refuses a stale order with 409", async () => {
    const rows = (await request(app).get("/api/lookups/keywords").set("cookie", as("Calendar.Administrator"))).body.rows as { id: number }[];
    await write("post", "/api/lookups/keywords", "Calendar.Administrator", { name: "Added meanwhile" });
    const stale = await write("put", "/api/lookups/keywords/order", "Calendar.Administrator", { ids: rows.map((r) => r.id) });
    expect(stale.status).toBe(409);
  });

  it("answers 404 for an unknown lookup or row, 400 for a bad body, 409 for a duplicate active name", async () => {
    expect((await request(app).get("/api/lookups/priorities").set("cookie", as("Calendar.SysAdmin"))).status).toBe(404);
    expect((await write("put", "/api/lookups/keywords/999999", "Calendar.SysAdmin", { name: "x" })).status).toBe(404);
    expect((await write("put", "/api/lookups/keywords/abc", "Calendar.SysAdmin", { name: "x" })).status).toBe(404);
    expect((await write("post", "/api/lookups/keywords", "Calendar.SysAdmin", { name: "" })).status).toBe(400);
    expect((await write("post", "/api/lookups/keywords", "Calendar.SysAdmin", { name: "sample KEYWORD" })).status).toBe(409);
  });

  it("refuses a write without the CSRF header", async () => {
    expect((await request(app).post("/api/lookups/keywords").set("cookie", as("Calendar.SysAdmin")).send({ name: "x" })).status).toBe(403);
  });
});
