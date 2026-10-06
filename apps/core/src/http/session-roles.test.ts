import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintLocalToken, mintSession } from "@gcpe/auth";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema, setRoles, updateUser } from "../services/users";

const SECRET = "session-secret-for-roles-tests-0123456789";
const LOCAL_BEARER_SECRET = "local-bearer-secret-for-roles-tests-012345";

describe("Core /api re-checks session identity on every request", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({
      db: tdb.db,
      subscribers: [],
      auth: { session: { secret: SECRET }, local: { secret: LOCAL_BEARER_SECRET } },
      session: { secret: SECRET, secure: false, local: null },
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const postUsers = (cookie: string) => request(app).post("/api/users").set("cookie", cookie).set("x-gcpe-request", "1").send({ email: `new-${Date.now()}@example.test`, displayName: "New" });

  it("401s a deactivated Core.Admin's old session cookie instead of trusting its stale roles", async () => {
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "deactivated-admin@example.test", displayName: "Deactivated Admin", roles: ["Core.Admin"], password: "admin password 123" }));
    const cookie = `gcpe_session=${(await mintSession(SECRET, { id: admin.id, name: "Deactivated Admin", email: admin.email, roles: ["Core.Admin"] })).token}`;

    // Sanity: the cookie works before deactivation.
    expect((await postUsers(cookie)).status).toBe(201);

    await updateUser(tdb.db, admin.id, { isActive: false });

    const res = await postUsers(cookie);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "not signed in" });
  });

  it("403s a demoted Core.Admin's old session cookie instead of trusting its stale roles", async () => {
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "demoted-admin@example.test", displayName: "Demoted Admin", roles: ["Core.Admin"], password: "admin password 123" }));
    const cookie = `gcpe_session=${(await mintSession(SECRET, { id: admin.id, name: "Demoted Admin", email: admin.email, roles: ["Core.Admin"] })).token}`;

    await setRoles(tdb.db, admin.id, ["NRMS.Viewer"]);

    const res = await postUsers(cookie);
    expect(res.status).toBe(403);
  });

  it("leaves bearer-token requests unaffected (no session row to re-check)", async () => {
    const token = await mintLocalToken({ secret: LOCAL_BEARER_SECRET, subject: "svc-account", roles: ["Core.Admin"] });
    const res = await request(app).post("/api/users").set("authorization", `Bearer ${token}`).send({ email: `bearer-${Date.now()}@example.test`, displayName: "Bearer Created" });
    expect(res.status).toBe(201);
  });
});
