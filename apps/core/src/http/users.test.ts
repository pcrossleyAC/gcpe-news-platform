import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { outboxEvents } from "@gcpe/events";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { users } from "../db/schema";
import { createUser, createUserSchema } from "../services/users";

const SECRET = "session-secret-for-users-tests-0123456789";

describe("Core users API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;
  let viewerCookie: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: false, local: null } });
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "admin@example.test", displayName: "Admin", roles: ["Core.Admin"], password: "admin password 123" }), []);
    adminId = admin.id;
    adminCookie = `gcpe_session=${(await mintSession(SECRET, { id: admin.id, name: "Admin", email: admin.email ?? "", roles: ["Core.Admin"] })).token}`;
    const viewer = await createUser(tdb.db, createUserSchema.parse({ email: "viewer@example.test", displayName: "V", roles: ["NRMS.Viewer"], password: "viewer password 123" }), []);
    viewerCookie = `gcpe_session=${(await mintSession(SECRET, { id: viewer.id, name: "V", email: viewer.email ?? "", roles: ["NRMS.Viewer"] })).token}`;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const as = (cookie: string) => ({
    get: (p: string) => request(app).get(p).set("cookie", cookie),
    post: (p: string, body?: object) => request(app).post(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body ?? {}),
    patch: (p: string, body: object) => request(app).patch(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
    put: (p: string, body: object) => request(app).put(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
  });

  it("is Core.Admin only", async () => {
    expect((await as(viewerCookie).get("/api/users")).status).toBe(403);
    expect((await request(app).get("/api/users")).status).toBe(401);
  });

  it("creates, lists, renames, deactivates and re-roles a user; the new user can sign in", async () => {
    const created = await as(adminCookie).post("/api/users", { email: "Site.Editor@Example.test", displayName: "Site Editor", roles: ["NRMS.SiteEditor"], password: "site editor pass 1" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      email: "site.editor@example.test",
      displayName: "Site Editor",
      isActive: true,
      signInMethod: "local",
      roles: ["NRMS.SiteEditor"],
      calendarRole: null,
      organizationKeys: [],
    });
    expect(JSON.stringify(created.body)).not.toContain("scrypt");
    const id = created.body.id as string;

    const signIn = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "site.editor@example.test", password: "site editor pass 1" });
    expect(signIn.status).toBe(200);

    expect((await as(adminCookie).get("/api/users")).body.map((u: { email: string }) => u.email)).toEqual(["admin@example.test", "site.editor@example.test", "viewer@example.test"]);
    expect((await as(adminCookie).patch(`/api/users/${id}`, { displayName: "Site Ed" })).body.displayName).toBe("Site Ed");
    expect((await as(adminCookie).put(`/api/users/${id}/roles`, { roles: ["NRMS.Viewer"] })).body.roles).toEqual(["NRMS.Viewer"]);
    expect((await as(adminCookie).post(`/api/users/${id}/password`, { password: "another long pass" })).status).toBe(204);
    expect((await as(adminCookie).patch(`/api/users/${id}`, { isActive: false })).body.isActive).toBe(false);
  });

  it("409s a duplicate email, 400s bad input, 404s unknown or malformed ids", async () => {
    const dup = await as(adminCookie).post("/api/users", { email: "ADMIN@example.test", displayName: "Again" });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "a user with that email already exists" });
    expect((await as(adminCookie).post("/api/users", { email: "not-an-email", displayName: "X" })).status).toBe(400);
    expect((await as(adminCookie).put("/api/users/00000000-0000-4000-8000-000000000000/roles", { roles: [] })).status).toBe(404);
    expect((await as(adminCookie).patch("/api/users/not-a-uuid", { isActive: true })).status).toBe(404);
    expect((await as(adminCookie).post("/api/users/not-a-uuid/password", { password: "long enough pass" })).status).toBe(404);
  });

  it("won't let an admin lock themself out", async () => {
    expect((await as(adminCookie).patch(`/api/users/${adminId}`, { isActive: false })).status).toBe(409);
    const drop = await as(adminCookie).put(`/api/users/${adminId}/roles`, { roles: ["NRMS.Editor"] });
    expect(drop.status).toBe(409);
    expect(drop.body).toEqual({ error: "you can't remove your own admin access" });
    expect((await as(adminCookie).put(`/api/users/${adminId}/roles`, { roles: ["Core.Admin", "NRMS.Editor"] })).status).toBe(200);
  });

  it("grants the NoD.Viewer and NoD.Editor roles", async () => {
    const created = await as(adminCookie).post("/api/users", { email: "nod.staff@example.test", displayName: "NoD Staff", roles: ["NoD.Viewer"], password: "nod staff pass 12" });
    expect(created.status).toBe(201);
    expect(created.body.roles).toEqual(["NoD.Viewer"]);
    const reroled = await as(adminCookie).put(`/api/users/${created.body.id}/roles`, { roles: ["NoD.Editor"] });
    expect(reroled.body.roles).toEqual(["NoD.Editor"]);
  });

  it("409s reactivating a no-email user, instead of a raw database error", async () => {
    const [noEmail] = await tdb.db.insert(users).values({ email: null, displayName: "No Email Import", isActive: false }).returning();
    const res = await as(adminCookie).patch(`/api/users/${noEmail!.id}`, { isActive: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "set an email before activating this user" });
  });
  it("won't let an admin lock themself out through their own id in another case", async () => {
    const upper = adminId.toUpperCase();
    expect((await as(adminCookie).patch(`/api/users/${upper}`, { isActive: false })).status).toBe(409);
    const drop = await as(adminCookie).put(`/api/users/${upper}/roles`, { roles: ["NRMS.Editor"] });
    expect(drop.status).toBe(409);
    expect(drop.body).toEqual({ error: "you can't remove your own admin access" });
    expect((await as(adminCookie).get("/api/users")).body.find((u: { id: string }) => u.id === adminId)).toMatchObject({ isActive: true, roles: expect.arrayContaining(["Core.Admin"]) });
  });

  it("a write to an id sent in another case lands on the stored id's event stream only", async () => {
    const count = async (aggregateId: string) => (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, aggregateId))).length;
    const staff = await createUser(tdb.db, createUserSchema.parse({ email: "case.staff@example.test", displayName: "Case Staff" }), []);
    const before = await count(`user:${staff.id}`);
    const upper = staff.id.toUpperCase();
    const renamed = await as(adminCookie).patch(`/api/users/${upper}`, { displayName: "Case Staff Renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.id).toBe(staff.id);
    expect((await as(adminCookie).put(`/api/users/${upper}/roles`, { roles: ["NRMS.Viewer"] })).status).toBe(200);
    expect(await count(`user:${staff.id}`)).toBe(before + 2);
    expect(await count(`user:${upper}`)).toBe(0);

    const [noEmail] = await tdb.db.insert(users).values({ email: null, displayName: "Kim Imported", isActive: false }).returning();
    const linked = await as(adminCookie).post(`/api/users/${noEmail!.id.toUpperCase()}/link`, { email: "kim.imported@example.test" });
    expect(linked.status).toBe(200);
    expect(await count(`user:${noEmail!.id}`)).toBe(1);
    expect(await count(`user:${noEmail!.id.toUpperCase()}`)).toBe(0);
  });
});
