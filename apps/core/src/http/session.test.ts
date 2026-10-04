import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword, mintSession } from "@gcpe/auth";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema, setRoles, updateUser } from "../services/users";

const SECRET = "session-secret-for-core-tests-0123456789";
const PW = "correct horse battery";
const ADMIN_PW = "break glass password!";

function sessionToken(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const c = raw?.find((v) => v.startsWith("gcpe_session="));
  return c?.slice("gcpe_session=".length).split(";")[0];
}

describe("Core sign-in", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let editorId: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const local = { username: "admin", passwordHash: await hashPassword(ADMIN_PW), secret: "local-secret-for-core-tests-0123456789" };
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: true, local } });
    editorId = (await createUser(tdb.db, createUserSchema.parse({ email: "editor@example.test", displayName: "Test Editor", roles: ["NRMS.Editor"], password: PW }))).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const login = (username: string, password: string, csrf = true) => {
    const r = request(app).post("/auth/login").send({ username, password });
    return csrf ? r.set("x-gcpe-request", "1") : r;
  };

  it("refuses a login without the CSRF header", async () => {
    expect((await login("editor@example.test", PW, false)).status).toBe(403);
  });

  it("refuses wrong credentials with one message", async () => {
    expect((await login("editor@example.test", "wrong password!!")).body).toEqual({ error: "invalid credentials" });
    expect((await login("nobody@example.test", PW)).status).toBe(401);
    expect((await login("", "")).status).toBe(401);
  });

  it("signs in (email in any case) and sets a secure HttpOnly cookie", async () => {
    const res = await login("  EDITOR@example.test ", PW);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: editorId, name: "Test Editor", email: "editor@example.test", roles: ["NRMS.Editor"] });
    const raw = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(raw).toMatch(/^gcpe_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure$/);
  });

  it("the cookie authenticates Core's API; writes need the CSRF header", async () => {
    const token = sessionToken(await login("editor@example.test", PW))!;
    expect((await request(app).get("/api/organizations").set("cookie", `gcpe_session=${token}`)).status).toBe(200);
    const write = await request(app).post("/api/admin/republish").set("cookie", `gcpe_session=${token}`);
    expect(write.status).toBe(403);
    expect(write.body).toEqual({ error: "missing X-GCPE-Request header" });
  });

  it("GET /auth/session returns the user without reissuing a fresh cookie", async () => {
    const token = sessionToken(await login("editor@example.test", PW))!;
    const res = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(editorId);
    expect(sessionToken(res)).toBeUndefined();
  });

  it("renews a cookie in its last 15 minutes", async () => {
    const { token } = await mintSession(SECRET, { id: editorId, name: "Test Editor", email: "editor@example.test", roles: ["NRMS.Editor"] }, 600);
    const res = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(res.status).toBe(200);
    expect(sessionToken(res)).toBeDefined();
  });

  it("reissues at once when roles changed, and signs out a deactivated user", async () => {
    const token = sessionToken(await login("editor@example.test", PW))!;
    await setRoles(tdb.db, editorId, ["NRMS.Viewer"]);
    const changed = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(changed.body.user.roles).toEqual(["NRMS.Viewer"]);
    expect(sessionToken(changed)).toBeDefined();
    await updateUser(tdb.db, editorId, { isActive: false });
    const gone = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(gone.status).toBe(401);
    expect(sessionToken(gone)).toBe("");
    await updateUser(tdb.db, editorId, { isActive: true });
    await setRoles(tdb.db, editorId, ["NRMS.Editor"]);
  });

  it("401s with no cookie or a garbage cookie", async () => {
    expect((await request(app).get("/auth/session")).status).toBe(401);
    expect((await request(app).get("/auth/session").set("cookie", "gcpe_session=garbage")).status).toBe(401);
  });

  it("break-glass admin signs in through the same endpoint", async () => {
    const res = await login("admin", ADMIN_PW);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: "local:admin", roles: ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NoD.Admin", "Distribution.Send"] });
    const token = sessionToken(res)!;
    expect((await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`)).status).toBe(200);
    expect((await login("admin", "not the password")).status).toBe(401);
  });

  it("logout needs the CSRF header and clears the cookie", async () => {
    expect((await request(app).post("/auth/logout")).status).toBe(403);
    const res = await request(app).post("/auth/logout").set("x-gcpe-request", "1");
    expect(res.status).toBe(204);
    expect(sessionToken(res)).toBe("");
  });
});
