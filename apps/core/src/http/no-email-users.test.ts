import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { asc, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { outboxEvents, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema } from "../services/users";

const SECRET = "session-secret-for-no-email-tests-0123456789";
const subs: SubscriberConfig[] = [{ name: "calendar", url: "http://x/events", secret: "s", types: ["user.upserted"] }];

describe("users without an email", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: subs, auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: false, local: null } });
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "admin@example.test", displayName: "Admin", roles: ["Core.Admin"] }), []);
    adminCookie = `gcpe_session=${(await mintSession(SECRET, { id: admin.id, name: "Admin", email: "admin@example.test", roles: ["Core.Admin"] })).token}`;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const as = (cookie: string) => ({
    post: (p: string, body: object) => request(app).post(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
    patch: (p: string, body: object) => request(app).patch(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
  });

  async function createNoEmail(displayName: string): Promise<string> {
    const res = await as(adminCookie).post("/api/users", { displayName, isActive: false, password: "a long enough password" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: null, isActive: false, displayName });
    return res.body.id as string;
  }

  it("creates inactive users with no email; an active one needs an email", async () => {
    await createNoEmail("Kim Imported");
    await createNoEmail("Lee Imported");
    const active = await as(adminCookie).post("/api/users", { displayName: "Active Nobody" });
    expect(active.status).toBe(400);
    expect(JSON.stringify(active.body.issues)).toContain("an active user needs an email");
  });

  it("can't be activated until an email is set; the database refuses it too", async () => {
    const id = await createNoEmail("Pat Imported");
    const res = await as(adminCookie).patch(`/api/users/${id}`, { isActive: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "set an email before activating this user" });
    const direct = await tdb.db.execute(sql`UPDATE users SET is_active = true WHERE id = ${id}`).catch((e: unknown) => e);
    expect((direct as { cause?: { code?: string } }).cause?.code ?? (direct as { code?: string }).code).toBe("23514");
  });

  it("can't sign in, and a session cookie minted for one is refused", async () => {
    const id = await createNoEmail("Sam Imported");
    for (const username of ["", " ", "Sam Imported"]) {
      const login = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username, password: "a long enough password" });
      expect(login.status).toBe(401);
    }
    const cookie = `gcpe_session=${(await mintSession(SECRET, { id, name: "Sam Imported", email: "", roles: [] })).token}`;
    expect((await request(app).get("/auth/session").set("cookie", cookie)).status).toBe(401);
    expect((await request(app).get("/api/organizations").set("cookie", cookie)).status).toBe(401);
  });

  it("link sets the email and activates in one step, emits user.upserted, and the user can then sign in", async () => {
    const id = await createNoEmail("Jo Imported");
    const linked = await as(adminCookie).post(`/api/users/${id}/link`, { email: " Jo.Imported@Example.test " });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ email: "jo.imported@example.test", isActive: true });
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`)).orderBy(asc(outboxEvents.sequence));
    expect((rows.at(-1)!.envelope as { data: UserRecord }).data).toMatchObject({ email: "jo.imported@example.test", isActive: true });
    const login = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "jo.imported@example.test", password: "a long enough password" });
    expect(login.status).toBe(200);
  });

  it("refuses link for a user who already has an email, an email already in use, and a malformed one", async () => {
    const id = await createNoEmail("Ali Imported");
    expect((await as(adminCookie).post(`/api/users/${id}/link`, { email: "not-an-email" })).status).toBe(400);
    const taken = await as(adminCookie).post(`/api/users/${id}/link`, { email: "ADMIN@example.test" });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: "a user with that email already exists" });
    expect((await as(adminCookie).post(`/api/users/${id}/link`, { email: "ali.imported@example.test" })).status).toBe(200);
    const again = await as(adminCookie).post(`/api/users/${id}/link`, { email: "ali.other@example.test" });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "this user already has an email" });
    expect((await as(adminCookie).post("/api/users/00000000-0000-4000-8000-000000000000/link", { email: "x@example.test" })).status).toBe(404);
  });
});
