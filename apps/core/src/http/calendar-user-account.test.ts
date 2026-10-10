import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mintLocalToken, mintSession, type CalendarRole } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { createApp } from "../app";
import { lockAggregate, userAggregateId } from "../services/aggregate";
import { setCalendarAccess } from "../services/calendar-access";
import { setOrganizationHq, upsertOrganization } from "../services/organizations";
import { createUser, createUserSchema, getUser } from "../services/users";
import { roleGrants } from "../db/schema";

const SECRET = "session-secret-for-calendar-user-account-01";
const LOCAL = "local-bearer-secret-for-calendar-user-account";
const SETUP = { id: "setup", roles: ["Core.Admin"] };

describe("Calendar Administrators: active and link (Q55)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const cookie: Record<string, string> = {};
  const id: Record<string, string> = {};

  async function person(name: string, opts: { flat?: string[]; calendar?: CalendarRole; orgs?: string[]; email?: string | null; active?: boolean } = {}) {
    const email = opts.email === undefined ? `${name}@example.test` : opts.email;
    const u = await createUser(tdb.db, createUserSchema.parse({ email, displayName: `Sample ${name}`, roles: opts.flat ?? [], isActive: opts.active ?? email !== null }), []);
    if (opts.calendar) await setCalendarAccess(tdb.db, SETUP, u.id, { role: opts.calendar, organizationKeys: opts.orgs ?? ["health"] }, []);
    id[name] = u.id;
    cookie[name] = `gcpe_session=${(await mintSession(SECRET, { id: u.id, name, email: email ?? "", roles: [] })).token}`;
  }
  const put = (actor: string, target: string, isActive: boolean) =>
    request(app).put(`/api/calendar-access/${id[target]}/active`).set("cookie", cookie[actor]!).set("x-gcpe-request", "1").send({ isActive });
  const link = (actor: string, target: string, email: string) =>
    request(app).post(`/api/calendar-access/${id[target]}/link`).set("cookie", cookie[actor]!).set("x-gcpe-request", "1").send({ email });

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET }, local: { secret: LOCAL } }, session: { secret: SECRET, secure: false, local: null } });
    await upsertOrganization(tdb.db, healthOrg, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true }, []);
    await person("coreAdmin", { flat: ["Core.Admin"] });
    await person("sysAdmin", { calendar: "Calendar.SysAdmin" });
    await person("admin", { calendar: "Calendar.Administrator" });
    await person("hqAdmin", { calendar: "Calendar.Administrator", orgs: ["gcpe-headquarters"] });
    await person("editor", { calendar: "Calendar.Editor" });
    await person("editor2", { calendar: "Calendar.Editor" });
    await person("nrmsToo", { flat: ["NRMS.Editor"], calendar: "Calendar.Editor" });
    await person("hqEditor", { calendar: "Calendar.Editor", orgs: ["gcpe-headquarters"] });
    await person("otherSys", { calendar: "Calendar.SysAdmin" });
    await person("imported", { email: null, calendar: "Calendar.Editor" });
    await person("imported2", { email: null, calendar: "Calendar.Editor" });
    await person("imported3", { email: null, calendar: "Calendar.Editor" });
    await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sectorKeys: [] }, []);
    // The NRMS legacy importer's shape: an email, inactive, no roles of any kind.
    await person("legacyStaff", { active: false });
    await person("bare", { email: null });
    await person("nrmsNoEmail", { email: null, flat: ["NRMS.Viewer"], calendar: "Calendar.Editor" });
    await person("hqNoEmail", { email: null, calendar: "Calendar.Editor", orgs: ["gcpe-headquarters"] });
    await person("financeEditor", { calendar: "Calendar.Editor", orgs: ["finance"] });
    await person("calendarNoEmail", { email: null, calendar: "Calendar.ReadOnly" });
  });
  afterAll(() => tdb.drop());

  it("an Administrator deactivates and reactivates a Calendar-only user", async () => {
    const off = await put("admin", "editor", false);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: id.editor, isActive: false, calendarRole: "Calendar.Editor" });
    expect((await put("admin", "editor", true)).body.isActive).toBe(true);
  });

  it("only a Core admin changes a user who also holds an NRMS or NoD role", async () => {
    const refused = await put("admin", "nrmsToo", false);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "only a Core admin can change a user who also has NRMS or NoD roles", reason: "other-roles" });
    expect((await put("sysAdmin", "nrmsToo", false)).status).toBe(403);
    expect((await getUser(tdb.db, id.nrmsToo!))!.isActive).toBe(true);
    expect((await put("coreAdmin", "nrmsToo", false)).status).toBe(200);
    await put("coreAdmin", "nrmsToo", true);
  });

  it("follows the grant rules with the role unchanged: no SysAdmin target for an Administrator, no HQ target for a non-HQ Administrator", async () => {
    expect((await put("admin", "otherSys", false)).body.reason).toBe("target-above-ceiling");
    expect((await put("admin", "hqEditor", false)).body.reason).toBe("hq-target");
    expect((await put("hqAdmin", "hqEditor", false)).status).toBe(200);
    expect((await put("sysAdmin", "otherSys", false)).status).toBe(200);
  });

  it("nobody deactivates themself here, whatever case their id is spelled in", async () => {
    expect((await put("admin", "admin", false)).status).toBe(409);
    expect((await put("coreAdmin", "coreAdmin", false)).status).toBe(409);
    const upper = await request(app).put(`/api/calendar-access/${id.coreAdmin!.toUpperCase()}/active`).set("cookie", cookie.coreAdmin!).set("x-gcpe-request", "1").send({ isActive: false });
    expect(upper.status).toBe(409);
    expect((await getUser(tdb.db, id.coreAdmin!))!.isActive).toBe(true);
  });

  it("a no-email user can't be activated, only linked; linking sets the email and activates", async () => {
    expect((await put("admin", "imported", true)).status).toBe(409);
    const linked = await link("admin", "imported", "kim.imported@example.test");
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ email: "kim.imported@example.test", isActive: true });
    expect((await link("admin", "imported", "again@example.test")).status).toBe(409);
    expect((await link("admin", "imported2", "kim.imported@example.test")).status).toBe(409); // email in use
  });

  it("is closed to anyone below Calendar Administrator, and 404s an unknown user", async () => {
    expect((await put("editor2", "editor", false)).status).toBe(403);
    expect((await request(app).put("/api/calendar-access/00000000-0000-4000-8000-000000000000/active").set("cookie", cookie.admin!).set("x-gcpe-request", "1").send({ isActive: false })).status).toBe(404);
  });

  it("refuses every bearer caller, even a Core.Admin: changing who can sign in takes a signed-in person", async () => {
    for (const roles of [["Core.Admin"], ["Calendar.Administrator"]]) {
      const token = await mintLocalToken({ secret: LOCAL, subject: id.sysAdmin!, roles });
      const active = await request(app).put(`/api/calendar-access/${id.editor}/active`).set("authorization", `Bearer ${token}`).send({ isActive: false });
      expect(active.status).toBe(403);
      const linked = await request(app).post(`/api/calendar-access/${id.imported3}/link`).set("authorization", `Bearer ${token}`).send({ email: "taken.over@example.test" });
      expect(linked.status).toBe(403);
    }
    expect((await getUser(tdb.db, id.editor!))!.isActive).toBe(true);
    expect((await getUser(tdb.db, id.imported3!))!).toMatchObject({ email: null, isActive: false });
  });

  it("a user with no Calendar role is a Core admin's to change, active or not, emailed or not", async () => {
    const refused = await put("admin", "legacyStaff", true);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "only a Core admin can change a user who has no Calendar role", reason: "no-calendar-role" });
    expect((await put("sysAdmin", "legacyStaff", false)).body.reason).toBe("no-calendar-role");
    expect((await getUser(tdb.db, id.legacyStaff!))!.isActive).toBe(false);
    const linked = await link("sysAdmin", "bare", "bare.linked@example.test");
    expect(linked.status).toBe(403);
    expect(linked.body.reason).toBe("no-calendar-role");
    expect((await getUser(tdb.db, id.bare!))!).toMatchObject({ email: null, isActive: false });
    expect((await put("coreAdmin", "legacyStaff", true)).status).toBe(200);
    expect((await link("admin", "calendarNoEmail", "readonly.linked@example.test")).status).toBe(200);
  });

  it("only a Core admin grants a Calendar role to an inactive user who has none, so grant-then-activate can't bring one in", async () => {
    const grant = (actor: string, target: string) =>
      request(app).put(`/api/calendar-access/${id[target]}`).set("cookie", cookie[actor]!).set("x-gcpe-request", "1").send({ role: "Calendar.ReadOnly", organizationKeys: ["health"] });
    await person("dormant", { active: false });
    await person("dormantNoEmail", { email: null });
    await person("activeNoRole");
    const before = await getUser(tdb.db, id.dormant!);

    const refused = await grant("admin", "dormant");
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "only a Core admin can change a user who has no Calendar role", reason: "no-calendar-role" });
    expect(await getUser(tdb.db, id.dormant!)).toEqual(before);
    expect((await put("admin", "dormant", true)).body.reason).toBe("no-calendar-role");
    expect((await getUser(tdb.db, id.dormant!))!.isActive).toBe(false);

    const refusedNoEmail = await grant("admin", "dormantNoEmail");
    expect(refusedNoEmail.status).toBe(403);
    expect(refusedNoEmail.body.reason).toBe("no-calendar-role");
    expect((await link("admin", "dormantNoEmail", "dormant.linked@example.test")).body.reason).toBe("no-calendar-role");
    expect((await getUser(tdb.db, id.dormantNoEmail!))!).toMatchObject({ email: null, isActive: false, calendarRole: null, organizationKeys: [] });

    const granted = await grant("admin", "activeNoRole");
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["health"] });

    const byCoreAdmin = await grant("coreAdmin", "dormant");
    expect(byCoreAdmin.status).toBe(200);
    expect(byCoreAdmin.body).toMatchObject({ isActive: false, calendarRole: "Calendar.ReadOnly" });
  });

  it("link follows the same rules as active: other roles and HQ targets are refused", async () => {
    expect((await link("admin", "nrmsNoEmail", "nrms.linked@example.test")).body).toEqual({ error: "only a Core admin can change a user who also has NRMS or NoD roles", reason: "other-roles" });
    expect((await link("admin", "hqNoEmail", "hq.linked@example.test")).body.reason).toBe("hq-target");
    expect((await getUser(tdb.db, id.hqNoEmail!))!.email).toBeNull();
    expect((await link("hqAdmin", "hqNoEmail", "hq.linked@example.test")).status).toBe(200);
  });

  it("link takes only an email", async () => {
    const res = await request(app).post(`/api/calendar-access/${id.imported3}/link`).set("cookie", cookie.admin!).set("x-gcpe-request", "1").send({ email: "extra.key@example.test", isActive: false });
    expect(res.status).toBe(400);
    expect((await getUser(tdb.db, id.imported3!))!.email).toBeNull();
  });

  it("a ministry that becomes HQ makes its holders HQ targets", async () => {
    expect((await put("admin", "financeEditor", false)).status).toBe(200);
    await setOrganizationHq(tdb.db, "finance", true, []);
    expect((await put("admin", "financeEditor", true)).body.reason).toBe("hq-target");
    await setOrganizationHq(tdb.db, "finance", false, []);
    expect((await put("admin", "financeEditor", true)).status).toBe(200);
  });

  it("the Q55 check runs under the user's lock: a role granted while the request waits is seen", async () => {
    await person("racer", { calendar: "Calendar.Editor" });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // Another writer holds the user's aggregate lock and grants an NRMS role inside it.
    const granting = tdb.db.transaction(async (tx) => {
      await lockAggregate(tx, userAggregateId(id.racer!));
      await tx.insert(roleGrants).values({ userId: id.racer!, role: "NRMS.Viewer" });
      await held;
    });
    const pending = put("admin", "racer", false).then((r) => r);
    await waitForLockWaiter(tdb);
    release();
    await granting;
    const res = await pending;
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("other-roles");
  });
});

/** Resolves once some session is blocked on a lock: the request has done its unlocked work and is queued behind the test's transaction. */
async function waitForLockWaiter(tdb: TestDatabase, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r.rows[0]!.n > 0) return;
    if (Date.now() > deadline) throw new Error("no session started waiting for a lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
