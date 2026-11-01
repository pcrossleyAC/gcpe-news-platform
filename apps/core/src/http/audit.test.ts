import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { createApp } from "../app";
import { coreAudit, roleGrants, users } from "../db/schema";
import { createUser, createUserSchema } from "../services/users";
import { upsertOrganization } from "../services/organizations";
import { publishDueCabinetChanges } from "../services/cabinet-changes";
import { BREAK_GLASS_ID, BREAK_GLASS_NAME } from "../services/sessions";

const SECRET = "session-secret-for-audit-tests-0123456789";
const SOCIAL = { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null };

/** Suite review O3: Core admin changes record who made them, and Core.Admin can read them back. */
describe("Core admin audit trail", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;
  let calAdminCookie: string;
  let viewerCookie: string;
  let breakGlassCookie: string;

  const cookieFor = async (u: { id: string; name: string; roles: string[] }) => `gcpe_session=${(await mintSession(SECRET, { ...u, email: "" })).token}`;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({
      db: tdb.db,
      subscribers: [],
      auth: { session: { secret: SECRET } },
      session: { secret: SECRET, secure: false, local: { username: "admin", passwordHash: "unused", secret: SECRET } },
    });
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "paul@example.test", displayName: "Paul Smith", roles: ["Core.Admin"], password: "admin password 123" }), []);
    adminId = admin.id;
    adminCookie = await cookieFor({ id: admin.id, name: "Paul Smith", roles: ["Core.Admin"] });
    await upsertOrganization(tdb.db, healthOrg, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sortOrder: 20 }, []);
    const cal = await createUser(tdb.db, createUserSchema.parse({ email: "cal@example.test", displayName: "Cal Admin", roles: [], password: "calendar pass 1234" }), []);
    await tdb.db.insert(roleGrants).values({ userId: cal.id, role: "Calendar.SysAdmin" });
    calAdminCookie = await cookieFor({ id: cal.id, name: "Cal Admin", roles: ["Calendar.SysAdmin"] });
    const viewer = await createUser(tdb.db, createUserSchema.parse({ email: "viewer@example.test", displayName: "Vee", roles: ["NRMS.Viewer"], password: "viewer password 123" }), []);
    viewerCookie = await cookieFor({ id: viewer.id, name: "Vee", roles: ["NRMS.Viewer"] });
    breakGlassCookie = await cookieFor({ id: BREAK_GLASS_ID, name: BREAK_GLASS_NAME, roles: ["Core.Admin"] });
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
  const historyOf = async (targetType: string, targetId: string) => {
    const res = await as(adminCookie).get(`/api/audit?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}&pageSize=100`);
    expect(res.status).toBe(200);
    return res.body.items as { action: string; actorId: string; actorName: string; targetLabel: string; details: Record<string, unknown> }[];
  };

  it("records every Users change with who made it, newest first, and nothing secret", async () => {
    const created = await as(adminCookie).post("/api/users", { email: "jo@example.test", displayName: "Jo Lee", roles: ["NRMS.Viewer"], password: "jo password 12345" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await as(adminCookie).patch(`/api/users/${id}`, { displayName: "Jo Lee-Park" }).expect(200);
    await as(adminCookie).put(`/api/users/${id}/roles`, { roles: ["Core.Admin", "NRMS.Viewer"] }).expect(200);
    await as(adminCookie).post(`/api/users/${id}/password`, { password: "a brand new secret pw" }).expect(204);
    await as(adminCookie).patch(`/api/users/${id}`, { isActive: false }).expect(200);
    await as(adminCookie).patch(`/api/users/${id}`, { isActive: true }).expect(200);

    const items = await historyOf("user", id);
    expect(items.map((i) => i.action)).toEqual(["user.activated", "user.deactivated", "user.password-set", "user.roles", "user.renamed", "user.created"]);
    expect(items.every((i) => i.actorId === adminId && i.actorName === "Paul Smith")).toBe(true);
    expect(items.find((i) => i.action === "user.roles")!.details).toEqual({ added: ["Core.Admin"], removed: [] });
    expect(items.find((i) => i.action === "user.renamed")!.details).toEqual({ from: "Jo Lee", to: "Jo Lee-Park" });
    expect(items.find((i) => i.action === "user.created")!.details).toEqual({ email: "jo@example.test", roles: ["NRMS.Viewer"], isActive: true });
    const raw = JSON.stringify(await tdb.db.select().from(coreAudit));
    expect(raw).not.toContain("a brand new secret pw");
    expect(raw).not.toContain("jo password 12345");
    expect(raw).not.toContain("scrypt");
  });

  it("records nothing for a change that changes nothing, or a refused one", async () => {
    const created = await as(adminCookie).post("/api/users", { email: "same@example.test", displayName: "Same", roles: ["NRMS.Viewer"] });
    const id = created.body.id as string;
    await as(adminCookie).put(`/api/users/${id}/roles`, { roles: ["NRMS.Viewer"] }).expect(200);
    await as(adminCookie).patch(`/api/users/${id}`, { displayName: "Same" }).expect(200);
    await as(adminCookie).put(`/api/users/${adminId}/roles`, { roles: [] }).expect(409);
    expect((await historyOf("user", id)).map((i) => i.action)).toEqual(["user.created"]);
    expect((await historyOf("user", adminId)).map((i) => i.action)).toEqual([]);
  });

  it("records linking a no-email user and unlinking Microsoft sign-in", async () => {
    const created = await createUser(tdb.db, createUserSchema.parse({ email: null, displayName: "No Email", isActive: false }), []);
    await as(adminCookie).post(`/api/users/${created.id}/link`, { email: "found@example.test" }).expect(200);
    await tdb.db.update(users).set({ entraOid: "oid-1", signInMethod: "entra" }).where(eq(users.id, created.id));
    await as(adminCookie).post(`/api/users/${created.id}/unlink-entra`).expect(200);
    const items = await historyOf("user", created.id);
    expect(items.map((i) => [i.action, i.details])).toEqual([
      ["user.microsoft-unlinked", {}],
      ["user.linked", { email: "found@example.test" }],
    ]);
  });

  it("records Calendar access changes by a Calendar administrator, under their own name", async () => {
    const target = await createUser(tdb.db, createUserSchema.parse({ email: "calu@example.test", displayName: "Cal User", roles: [] }), []);
    await as(calAdminCookie).put(`/api/calendar-access/${target.id}`, { role: "Calendar.Editor", organizationKeys: ["health"] }).expect(200);
    await as(calAdminCookie).put(`/api/calendar-access/${target.id}`, { role: "Calendar.Advanced", organizationKeys: ["finance"] }).expect(200);
    await as(calAdminCookie).put(`/api/calendar-access/${target.id}/active`, { isActive: false }).expect(200);
    const items = await historyOf("user", target.id);
    expect(items.map((i) => [i.action, i.actorName, i.details])).toEqual([
      ["user.deactivated", "Cal Admin", {}],
      ["calendar.access", "Cal Admin", { role: { from: "Calendar.Editor", to: "Calendar.Advanced" }, added: ["finance"], removed: ["health"] }],
      ["calendar.access", "Cal Admin", { role: { from: null, to: "Calendar.Editor" }, added: ["health"], removed: [] }],
    ]);
  });

  it("records Organizations changes: create, profile edit, HQ, public, deactivate, hand-over", async () => {
    const created = await as(adminCookie).post("/api/organizations", { displayName: "Ministry of Tests", abbreviation: "TEST" });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    await as(adminCookie).patch(`/api/organizations/${key}/profile`, { displayName: "Ministry of Trials", abbreviation: "TRIAL", minister: { name: "Hon. A" } }).expect(200);
    await as(adminCookie).put(`/api/organizations/${key}/hq`, { isHq: true }).expect(200);
    await as(adminCookie).put(`/api/organizations/${key}/hq`, { isHq: true }).expect(200); // no change: no entry
    await as(adminCookie).put(`/api/organizations/${key}/public`, { isPublic: false }).expect(200);
    const flags = { moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true };
    await as(adminCookie).post(`/api/organizations/${key}/succeed`, { successorKeys: ["finance"], ...flags }).expect(200);

    const items = await historyOf("organization", key);
    expect(items.map((i) => i.action)).toEqual(["org.handed-over", "org.public", "org.hq", "org.edited", "org.created"]);
    expect(items.find((i) => i.action === "org.edited")!.details).toEqual({
      name: { from: "Ministry of Tests", to: "Ministry of Trials" },
      abbreviation: { from: "TEST", to: "TRIAL" },
      fields: ["minister"],
    });
    expect(items[0]!.details).toMatchObject({ successors: [{ key: "finance", name: "Finance" }], takeAbbreviation: true, staffMoved: 0 });
    expect(items[0]!.targetLabel).toBe("Ministry of Trials");
    // The successor took the abbreviation: that is on its own history.
    const finance = await historyOf("organization", "finance");
    expect(finance.map((i) => [i.action, i.details])).toEqual([["org.edited", { abbreviation: { from: "FIN", to: "TRIAL" }, fields: [], via: "hand-over" }]]);

    await as(adminCookie).post(`/api/organizations/health/deactivate`).expect(204);
    expect((await historyOf("organization", "health")).map((i) => i.action)).toEqual(["org.deactivated"]);
  });

  it("records sector, theme, tag and service changes", async () => {
    await as(adminCookie).post("/api/terms/sector", { kind: "sector", key: "farming", displayName: "Farming", sortOrder: 1, isActive: true, social: SOCIAL }).expect(201);
    await as(adminCookie).put("/api/terms/sector/farming", { kind: "sector", key: "farming", displayName: "Agriculture", sortOrder: 1, isActive: true, social: SOCIAL }).expect(200);
    await as(adminCookie).post("/api/terms/sector/farming/deactivate").expect(204);
    const items = await historyOf("term", "sector:farming");
    expect(items.map((i) => [i.action, i.details])).toEqual([
      ["term.deactivated", { kind: "sector" }],
      ["term.edited", { kind: "sector", name: { from: "Farming", to: "Agriculture" }, fields: [] }],
      ["term.created", { kind: "sector" }],
    ]);
  });

  it("names the break-glass administrator as the Hub does", async () => {
    const created = await as(breakGlassCookie).post("/api/users", { email: "bg@example.test", displayName: "From Break Glass", roles: [] });
    expect(created.status).toBe(201);
    const [entry] = await historyOf("user", created.body.id as string);
    expect(entry).toMatchObject({ actorId: BREAK_GLASS_ID, actorName: "Administrator (break-glass)" });
  });

  it("records cabinet change actions", async () => {
    const rename = { op: "update", key: "finance", expectedUpdatedAt: (await as(adminCookie).get("/api/organizations/finance")).body.updatedAt, patch: { displayName: "Finance and Treasury" } };
    await as(adminCookie).put("/api/cabinet-change", { operations: [rename] }).expect(200);
    const published = await as(adminCookie).post("/api/cabinet-change/publish");
    expect(published.status).toBe(200);
    const all = (await as(adminCookie).get("/api/audit?kind=cabinet")).body.items as { action: string; details: unknown }[];
    expect(all.map((i) => [i.action, i.details])).toEqual([
      ["cabinet.published", { operations: 1 }],
      ["cabinet.saved", { operations: 1 }],
    ]);
    // The rename it published is on the ministry's own history.
    const [rename1] = await historyOf("organization", "finance");
    expect(rename1).toMatchObject({ action: "org.edited", actorName: "Paul Smith", details: { name: { from: "Finance", to: "Finance and Treasury" }, via: "cabinet-change" } });
  });

  it("a scheduled cabinet change that publishes on its own is recorded as the scheduled change, after who scheduled it", async () => {
    const rename = { op: "update", key: "finance", expectedUpdatedAt: (await as(adminCookie).get("/api/organizations/finance")).body.updatedAt, patch: { displayName: "Treasury" } };
    await as(adminCookie).put("/api/cabinet-change", { operations: [rename] }).expect(200);
    const at = new Date(Date.now() + 60_000);
    await as(adminCookie).post("/api/cabinet-change/schedule", { at: at.toISOString() }).expect(200);
    expect(await publishDueCabinetChanges(tdb.db, [], () => new Date(at.getTime() + 1000))).toEqual({ published: 1, failed: 0 });
    const latest = (await as(adminCookie).get("/api/audit?kind=cabinet&pageSize=3")).body.items as { action: string; actorName: string; details: unknown }[];
    expect(latest.map((i) => [i.action, i.actorName])).toEqual([
      ["cabinet.published", "Scheduled cabinet change"],
      ["cabinet.scheduled", "Paul Smith"],
      ["cabinet.saved", "Paul Smith"],
    ]);
    expect(latest[1]!.details).toEqual({ at: at.toISOString() });
    const [renamed] = await historyOf("organization", "finance");
    expect(renamed).toMatchObject({ action: "org.edited", actorName: "Scheduled cabinet change", details: { name: { from: "Finance and Treasury", to: "Treasury" }, via: "cabinet-change" } });
  });

  it("GET /api/audit is Core.Admin only, filters by who, what and BC dates, and pages", async () => {
    expect((await as(viewerCookie).get("/api/audit")).status).toBe(403);
    expect((await as(calAdminCookie).get("/api/audit")).status).toBe(403);
    expect((await request(app).get("/api/audit")).status).toBe(401);
    expect((await as(adminCookie).get("/api/audit?page=0")).status).toBe(400);
    expect((await as(adminCookie).get("/api/audit?targetType=user")).status).toBe(400);

    const all = (await as(adminCookie).get("/api/audit?pageSize=100")).body as { total: number; items: { id: number; actorName: string; action: string }[] };
    expect(all.total).toBeGreaterThan(10);
    const page2 = (await as(adminCookie).get("/api/audit?pageSize=5&page=2")).body as { items: { id: number }[]; page: number; pageSize: number; total: number };
    expect(page2.items.map((i) => i.id)).toEqual(all.items.slice(5, 10).map((i) => i.id));
    expect(page2).toMatchObject({ page: 2, pageSize: 5, total: all.total });

    const cal = (await as(adminCookie).get("/api/audit?who=cal%20ad&pageSize=100")).body.items as { actorName: string }[];
    expect(cal.length).toBe(3);
    expect(cal.every((i) => i.actorName === "Cal Admin")).toBe(true);
    // % is a letter here, not a wildcard.
    expect((await as(adminCookie).get("/api/audit?who=%25")).body.total).toBe(0);
    const orgs = (await as(adminCookie).get("/api/audit?kind=organizations&pageSize=100")).body.items as { action: string }[];
    expect(orgs.length).toBeGreaterThan(0);
    expect(orgs.every((i) => i.action.startsWith("org."))).toBe(true);

    // Dates are BC days: an entry at 11:30 PM BC on Oct 30 is on Oct 30, not Oct 31 (its UTC date).
    await tdb.db.insert(coreAudit).values({ at: new Date("2020-10-31T06:30:00Z"), actorId: "x", actorName: "Late Night", action: "user.renamed", targetType: "user", targetId: "x", targetLabel: "X", details: {} });
    const oct30 = (await as(adminCookie).get("/api/audit?from=2020-10-30&to=2020-10-30")).body.items as { actorName: string }[];
    expect(oct30.map((i) => i.actorName)).toEqual(["Late Night"]);
    expect((await as(adminCookie).get("/api/audit?from=2020-10-31&to=2020-10-31")).body.total).toBe(0);
    expect((await as(adminCookie).get("/api/audit?to=2020-10-29")).body.total).toBe(0);
    expect((await as(adminCookie).get("/api/audit?from=2020-02-30")).status).toBe(400);
  });
});

describe("Last sign-in", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: false, local: null } });
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "admin@example.test", displayName: "Admin", roles: ["Core.Admin"], password: "admin password 123" }), []);
    adminCookie = `gcpe_session=${(await mintSession(SECRET, { id: admin.id, name: "Admin", email: "", roles: ["Core.Admin"] })).token}`;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("is null until the person signs in with a password, then the sign-in time; the Users list carries it", async () => {
    const list = async () => (await request(app).get("/api/users").set("cookie", adminCookie)).body as { email: string; lastSignInAt: string | null }[];
    expect((await list()).find((u) => u.email === "admin@example.test")!.lastSignInAt).toBeNull();
    const before = Date.now();
    await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "admin@example.test", password: "admin password 123" }).expect(200);
    const stamped = (await list()).find((u) => u.email === "admin@example.test")!.lastSignInAt;
    expect(stamped).not.toBeNull();
    expect(Date.parse(stamped!)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    // A wrong password is not a sign-in.
    await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "admin@example.test", password: "wrong password 123" }).expect(401);
    expect((await list()).find((u) => u.email === "admin@example.test")!.lastSignInAt).toBe(stamped);
  });
});
