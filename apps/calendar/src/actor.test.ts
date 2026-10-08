import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, mintLocalToken } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import type { UserRecord } from "@gcpe/events";
import { createApp } from "./app";
import { createCalendarTestDb, createTestApp, EVENT_SECRETS, projectOrg, projectUser, SESSION_SECRET, sessionCookie } from "../test/helpers";

/** A gcpe-local JWT with whatever claims the holder of the local secret chooses. */
const signHs256 = (secret: string, claims: Record<string, unknown>) => {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n: number, over: Partial<UserRecord> = {}): UserRecord => ({
  id: id(n),
  email: `user${n}@example.test`,
  displayName: `Sample User ${n}`,
  isActive: true,
  calendarRole: "Calendar.Editor",
  organizationKeys: ["health"],
  ...over,
});

describe("the Calendar actor, re-derived on every request", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  const me = async (cookie: string) => request(app).get("/api/me").set("cookie", cookie);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    await projectOrg(app, "finance", { abbreviation: "FIN" });
  });
  afterAll(() => tdb.drop());

  it("returns the projection's role, level, ministries and HQ, not the cookie's roles", async () => {
    await projectUser(app, user(1));
    const res = await me(await sessionCookie(id(1), ["Calendar.SysAdmin", "Core.Admin"]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: id(1), displayName: "Sample User 1", role: "Calendar.Editor", level: 2, ministryKeys: ["health"], isHq: false });
  });

  it("a revoked grant takes effect on the next request, whatever the cookie says", async () => {
    await projectUser(app, user(2, { calendarRole: "Calendar.Administrator" }));
    const cookie = await sessionCookie(id(2), ["Calendar.Administrator"]);
    expect((await me(cookie)).status).toBe(200);
    await projectUser(app, user(2, { calendarRole: null }));
    const after = await me(cookie);
    expect(after.status).toBe(403);
    expect(after.body).toEqual({ error: "no Calendar access" });
  });

  it("a deactivated user, and a user the projection has never seen, have no Calendar access", async () => {
    await projectUser(app, user(3, { isActive: false }));
    expect((await me(await sessionCookie(id(3), ["Calendar.Editor"]))).status).toBe(403);
    expect((await me(await sessionCookie(id(99), ["Calendar.SysAdmin"]))).status).toBe(403);
  });

  it("HQ follows the org projection, whichever event arrives first", async () => {
    await projectUser(app, user(4, { organizationKeys: ["gcpe-media-relations"] }));
    const cookie = await sessionCookie(id(4));
    expect((await me(cookie)).body.isHq).toBe(false);
    await projectOrg(app, "gcpe-media-relations", { isHq: true });
    expect((await me(cookie)).body.isHq).toBe(true);
  });

  it("a deactivated HQ organization still makes its members HQ, as in Core's grant checks (Q56)", async () => {
    await projectOrg(app, "retired-hq", { isHq: true, isActive: false });
    await projectUser(app, user(5, { organizationKeys: ["retired-hq"] }));
    expect((await me(await sessionCookie(id(5)))).body.isHq).toBe(true);
  });

  it("a bearer token has no Calendar access even when its subject is a projected user's id", async () => {
    await projectUser(app, user(6, { calendarRole: "Calendar.SysAdmin" }));
    const local = "calendar-local-bearer-secret-0123456789ab";
    const withLocal = createApp({ db: tdb.db, auth: { session: { secret: SESSION_SECRET }, local: { secret: local } }, eventSecrets: EVENT_SECRETS });
    const token = await mintLocalToken({ secret: local, subject: id(6), roles: ["Calendar.SysAdmin"] });
    expect((await request(withLocal).get("/api/me").set("authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await request(withLocal).get("/api/me").set("cookie", await sessionCookie(id(6)))).status).toBe(200);
  });

  it("a bearer token that claims to be a session still has no Calendar access", async () => {
    await projectUser(app, user(7, { calendarRole: "Calendar.SysAdmin" }));
    const local = "calendar-local-bearer-secret-0123456789ab";
    const withLocal = createApp({ db: tdb.db, auth: { session: { secret: SESSION_SECRET }, local: { secret: local } }, eventSecrets: EVENT_SECRETS });
    const now = Math.floor(Date.now() / 1000);
    const forged = signHs256(local, { iss: LOCAL_ISSUER, aud: LOCAL_AUDIENCE, sub: id(7), iat: now, exp: now + 300, via: "session", roles: ["Calendar.SysAdmin"] });
    const res = await request(withLocal).get("/api/me").set("authorization", `Bearer ${forged}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "no Calendar access" });
  });

  it("anonymous is 401", async () => {
    expect((await request(app).get("/api/me")).status).toBe(401);
  });
});
