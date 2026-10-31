// Owner decision 2026-10-31: "yes, 12 hours, and end deactivated sessions immediately."
// Sessions last at most 12 hours from sign-in whatever the renewals; a deactivation ends every one
// of that person's sessions on the very next request; Sign out ends that session on the server.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { decodeJwt, SignJWT } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword } from "@gcpe/auth";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { staffSessions } from "../db/schema";
import { createUser, createUserSchema, updateUser } from "../services/users";

const SECRET = "session-secret-for-limits-tests-0123456789";
const PW = "correct horse battery";
const ADMIN_PW = "break glass password!";
const T0 = new Date("2026-11-02T08:00:00Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (minutes: number) => vi.setSystemTime(new Date(T0.getTime() + minutes * 60_000));

function cookieOf(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((v) => v.startsWith("gcpe_session="));
}
const tokenOf = (res: request.Response) => cookieOf(res)?.slice("gcpe_session=".length).split(";")[0];

describe("Core session limits", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let n = 0;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const local = { username: "admin", passwordHash: await hashPassword(ADMIN_PW), secret: "local-secret-for-limits-tests-0123456789" };
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: true, local, ratePerMinute: 1000 } });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const newUser = async (roles: string[] = ["NRMS.Editor"]) => {
    const email = `limits-${++n}@example.test`;
    const u = await createUser(tdb.db, createUserSchema.parse({ email, displayName: `Limits ${n}`, roles, password: PW }), []);
    return { id: u.id, email };
  };
  const login = (username: string, password = PW) => request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username, password });
  const check = (token: string) => request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
  const api = (token: string) => request(app).get("/api/organizations").set("cookie", `gcpe_session=${token}`);

  it("a sign-in carries its sign-in time and a session id, recorded in Core", async () => {
    const u = await newUser();
    const res = await login(u.email);
    expect(res.status).toBe(200);
    const claims = decodeJwt(tokenOf(res)!);
    expect(typeof claims.sat).toBe("number");
    expect(typeof claims.sid).toBe("string");
    const rows = await tdb.db.select().from(staffSessions).where(eq(staffSessions.sid, String(claims.sid)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: u.id, endedAt: null });
    expect(sec(rows[0]!.signedAt)).toBe(claims.sat);
  });

  it("12-hour boundary with a fake clock: at 11:59 the check-in renews (to the 12-hour mark only), at 12:01 it is refused and the cookie cleared", async () => {
    const u = await newUser();
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    let token = tokenOf(await login(u.email))!;
    // Check in every 10 minutes, as the Hub does, renewing whenever Core reissues.
    const expiries: number[] = [];
    for (let m = 10; m <= 11 * 60 + 50; m += 10) {
      at(m);
      const res = await check(token);
      expect(res.status, `check-in at minute ${m}`).toBe(200);
      const next = tokenOf(res);
      if (next) {
        token = next;
        const c = decodeJwt(token);
        expect(c.sat).toBe(sec(T0));
        expiries.push(c.exp!);
      }
    }
    at(11 * 60 + 59);
    const late = await check(token);
    expect(late.status).toBe(200);
    expect(Date.parse(late.body.expiresAt) / 1000).toBe(sec(T0) + 12 * 3600);
    if (tokenOf(late)) token = tokenOf(late)!;
    // Renewals never extend past 12 hours after sign-in.
    expect(expiries.length).toBeGreaterThan(5);
    for (const exp of expiries) expect(exp).toBeLessThanOrEqual(sec(T0) + 12 * 3600);

    at(12 * 60 + 1);
    const over = await check(token);
    expect(over.status).toBe(401);
    expect(tokenOf(over)).toBe("");
    const apiOver = await api(token);
    expect(apiOver.status).toBe(401);
    expect(tokenOf(apiOver)).toBe("");
  });

  it("the break-glass admin's session has the same 12-hour limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    let token = tokenOf(await login("admin", ADMIN_PW))!;
    for (let m = 50; m <= 11 * 60 + 50; m += 50) {
      at(m);
      const res = await check(token);
      expect(res.status, `minute ${m}`).toBe(200);
      token = tokenOf(res) ?? token;
    }
    at(12 * 60 + 1);
    expect((await check(token)).status).toBe(401);
  });

  it("a deactivated user's next request is refused with the cookie cleared; reactivating doesn't bring the old cookie back; signing in again works", async () => {
    const u = await newUser();
    const token = tokenOf(await login(u.email))!;
    expect((await api(token)).status).toBe(200);
    await updateUser(tdb.db, u.id, { isActive: false }, []);
    const refused = await api(token);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "not signed in" });
    expect(tokenOf(refused)).toBe(""); // G-review M1: Core clears the cookie too
    expect((await check(token)).status).toBe(401);
    // Signing in while inactive fails plainly, but only with the right password.
    const inactive = await login(u.email);
    expect(inactive.status).toBe(403);
    expect(inactive.body).toEqual({ error: "inactive" });
    expect((await login(u.email, "not the password!!")).status).toBe(401);

    await updateUser(tdb.db, u.id, { isActive: true }, []);
    expect((await api(token)).status).toBe(401);
    const again = await login(u.email);
    expect(again.status).toBe(200);
    expect((await api(tokenOf(again)!)).status).toBe(200);
  });

  it("Sign out ends that session on the server: the same cookie no longer works anywhere", async () => {
    const u = await newUser();
    const token = tokenOf(await login(u.email))!;
    const other = tokenOf(await login(u.email))!; // another computer
    const out = await request(app).post("/auth/logout").set("x-gcpe-request", "1").set("cookie", `gcpe_session=${token}`);
    expect(out.status).toBe(204);
    expect((await api(token)).status).toBe(401);
    expect((await check(token)).status).toBe(401);
    expect((await api(other)).status).toBe(200);
  });

  it("break-glass sign-out ends that session on the server too", async () => {
    const token = tokenOf(await login("admin", ADMIN_PW))!;
    expect((await api(token)).status).toBe(200);
    await request(app).post("/auth/logout").set("x-gcpe-request", "1").set("cookie", `gcpe_session=${token}`);
    expect((await api(token)).status).toBe(401);
  });

  it("a token from before the deploy (no sign-in time, no session id) works while the person is active, counts from its issue time, and its next renewal records a session", async () => {
    const u = await newUser();
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const { localKey } = await import("../../../../packages/auth/src/local");
    const legacy = await new SignJWT({ name: `Limits ${n}`, email: u.email, roles: ["NRMS.Editor"] })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("gcpe-session")
      .setAudience("gcpe-session")
      .setSubject(u.id)
      .setIssuedAt(sec(T0))
      .setExpirationTime(sec(T0) + 3600)
      .sign(localKey(SECRET));
    at(5);
    expect((await api(legacy)).status).toBe(200);
    // Renewed at the next check-in, whatever its remaining life, so it gets a session Core can end.
    const renewed = await check(legacy);
    expect(renewed.status).toBe(200);
    const claims = decodeJwt(tokenOf(renewed)!);
    expect(claims.sat).toBe(sec(T0));
    expect(typeof claims.sid).toBe("string");
    expect(await tdb.db.select().from(staffSessions).where(eq(staffSessions.sid, String(claims.sid)))).toHaveLength(1);
    await updateUser(tdb.db, u.id, { isActive: false }, []);
    expect((await api(legacy)).status).toBe(401);
    expect((await api(tokenOf(renewed)!)).status).toBe(401);
  });
});
