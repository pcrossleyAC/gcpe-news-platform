import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, asc, eq, like } from "drizzle-orm";
import type { TestDatabase, Tx } from "@gcpe/db-kit";
import { CALENDAR_ROLES, mintLocalToken, mintSession, type CalendarRole } from "@gcpe/auth";
import { outboxEvents, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { createApp } from "../app";
import { organizations, roleGrants, userOrganizations } from "../db/schema";
import { lockAggregate, orgAggregateId, userAggregateId } from "../services/aggregate";
import { setCalendarAccess } from "../services/calendar-access";
import { deactivateOrganization, setOrganizationHq, upsertOrganization } from "../services/organizations";
import { createUser, createUserSchema } from "../services/users";

const SECRET = "session-secret-for-calendar-access-0123456789";
const LOCAL = "local-bearer-secret-for-calendar-access-0123";
const subs: SubscriberConfig[] = [{ name: "calendar", url: "http://x/events", secret: "s", types: ["user.upserted"] }];
const SETUP = { id: "setup", roles: ["Core.Admin"] };

type ActorName = "coreAdmin" | "sysAdmin" | "adminHq" | "adminMedia" | "adminPrem" | "adminHealth" | "advanced" | "editor" | "readOnly" | "nrmsEditor";
const ACTORS: Record<ActorName, { flat: string[]; calendar: CalendarRole | null; orgs: string[] }> = {
  coreAdmin: { flat: ["Core.Admin"], calendar: null, orgs: [] },
  sysAdmin: { flat: [], calendar: "Calendar.SysAdmin", orgs: ["health"] },
  adminHq: { flat: [], calendar: "Calendar.Administrator", orgs: ["gcpe-headquarters"] },
  // GCPEMEDIA and PREM are HQ too (Q49): their Administrators get every HQ privilege GCPEHQ's do (C124).
  adminMedia: { flat: [], calendar: "Calendar.Administrator", orgs: ["gcpe-media-relations"] },
  adminPrem: { flat: [], calendar: "Calendar.Administrator", orgs: ["office-of-the-premier"] },
  adminHealth: { flat: [], calendar: "Calendar.Administrator", orgs: ["health"] },
  advanced: { flat: [], calendar: "Calendar.Advanced", orgs: ["health"] },
  editor: { flat: [], calendar: "Calendar.Editor", orgs: ["health"] },
  readOnly: { flat: [], calendar: "Calendar.ReadOnly", orgs: ["health"] },
  nrmsEditor: { flat: ["NRMS.Editor"], calendar: null, orgs: [] },
};
// The target's requested ministries, relative to the ministry-level actors' own ministry (Health).
const RELATIONS = { own: ["health"], shared: ["finance", "health"], other: ["finance"], hq: ["gcpe-headquarters"] } as const;
type Relation = keyof typeof RELATIONS;
const HQ_KEYS = new Set(["gcpe-headquarters", "gcpe-media-relations", "office-of-the-premier"]);

/** The rules restated from the spec, independently of checkCalendarGrant: C125, plus the HQ-ministry rule. */
function expectedStatus(actor: ActorName, relation: Relation, role: CalendarRole | null): 200 | 403 {
  const a = ACTORS[actor];
  const ceiling = a.flat.includes("Core.Admin") || a.calendar === "Calendar.SysAdmin" ? 5 : a.calendar === "Calendar.Administrator" ? 4 : 0;
  if (ceiling === 0) return 403;
  if (role !== null && CALENDAR_ROLES.indexOf(role) + 1 > ceiling) return 403;
  if (relation === "hq" && ceiling < 5 && !a.orgs.some((k) => HQ_KEYS.has(k))) return 403;
  return 200;
}

describe("Calendar access API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const ids = {} as Record<ActorName, string>;
  const cookies = {} as Record<ActorName, string>;
  let targetId: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: subs, auth: { session: { secret: SECRET }, local: { secret: LOCAL } }, session: { secret: SECRET, secure: false, local: null } });
    await upsertOrganization(tdb.db, healthOrg, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sectorKeys: [] }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-media-relations", displayName: "GCPE Media Relations", abbreviation: "GCPEMEDIA", sectorKeys: [], isHq: true }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "office-of-the-premier", displayName: "Office of the Premier", abbreviation: "PREM", sectorKeys: [], isHq: true }, []);
    for (const [name, a] of Object.entries(ACTORS) as [ActorName, (typeof ACTORS)[ActorName]][]) {
      const u = await createUser(tdb.db, createUserSchema.parse({ email: `${name.toLowerCase()}@example.test`, displayName: name, roles: a.flat }), []);
      if (a.calendar) await setCalendarAccess(tdb.db, SETUP, u.id, { role: a.calendar, organizationKeys: a.orgs }, []);
      ids[name] = u.id;
      // Roles in the cookie don't matter: Core re-derives them from the database on every /api call.
      cookies[name] = `gcpe_session=${(await mintSession(SECRET, { id: u.id, name, email: `${name.toLowerCase()}@example.test`, roles: [] })).token}`;
    }
    targetId = (await createUser(tdb.db, createUserSchema.parse({ email: "robin.staff@example.test", displayName: "Robin Staff" }), [])).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const put = (cookie: string, id: string, body: object) => request(app).put(`/api/calendar-access/${id}`).set("cookie", cookie).set("x-gcpe-request", "1").send(body);

  async function userEvents(id: string): Promise<UserRecord[]> {
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`)).orderBy(asc(outboxEvents.sequence));
    return rows.map((r) => (r.envelope as { data: UserRecord }).data);
  }

  async function resetTarget() {
    await tdb.db.delete(roleGrants).where(and(eq(roleGrants.userId, targetId), like(roleGrants.role, "Calendar.%")));
    await tdb.db.delete(userOrganizations).where(eq(userOrganizations.userId, targetId));
  }

  it("role × ministry relation × HQ: each grant is allowed or refused exactly as the rules say, and only allowed grants emit", async () => {
    const mismatches: string[] = [];
    for (const actor of Object.keys(ACTORS) as ActorName[]) {
      for (const relation of Object.keys(RELATIONS) as Relation[]) {
        for (const role of [null, ...CALENDAR_ROLES] as (CalendarRole | null)[]) {
          await resetTarget();
          const before = (await userEvents(targetId)).length;
          const res = await put(cookies[actor], targetId, { role, organizationKeys: [...RELATIONS[relation]] });
          const want = expectedStatus(actor, relation, role);
          const label = `${actor} gives ${role ?? "no role"} with ${relation} ministries`;
          if (res.status !== want) {
            mismatches.push(`${label}: got ${res.status}, want ${want}`);
            continue;
          }
          const events = await userEvents(targetId);
          if (want === 200) {
            const last = events.at(-1);
            const ok = events.length === before + 1 && last?.calendarRole === role && JSON.stringify(last.organizationKeys) === JSON.stringify([...RELATIONS[relation]].sort());
            if (!ok) mismatches.push(`${label}: event ${JSON.stringify(last)}`);
            if (res.body.calendarRole !== role) mismatches.push(`${label}: response ${JSON.stringify(res.body)}`);
          } else if (events.length !== before) {
            mismatches.push(`${label}: a refused grant emitted`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("names the reason: an Administrator asking for SysAdmin, or for an HQ ministry while not HQ", async () => {
    await resetTarget();
    const sys = await put(cookies.adminHealth, targetId, { role: "Calendar.SysAdmin", organizationKeys: ["health"] });
    expect(sys.status).toBe(403);
    expect(sys.body).toEqual({ error: "only a System Administrator or a Core admin can grant System Administrator", reason: "above-ceiling" });
    const hq = await put(cookies.adminHealth, targetId, { role: "Calendar.Editor", organizationKeys: ["gcpe-headquarters"] });
    expect(hq.body).toEqual({ error: "only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry", reason: "hq-organization" });
  });

  it("an Administrator can't touch a SysAdmin, not even to lower or remove their role", async () => {
    await resetTarget();
    await setCalendarAccess(tdb.db, SETUP, targetId, { role: "Calendar.SysAdmin", organizationKeys: ["health"] }, []);
    for (const role of [null, "Calendar.ReadOnly", "Calendar.Administrator"]) {
      const res = await put(cookies.adminHq, targetId, { role, organizationKeys: ["health"] });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("target-above-ceiling");
    }
    expect((await put(cookies.sysAdmin, targetId, { role: "Calendar.Editor", organizationKeys: ["health"] })).status).toBe(200);
  });

  it("only a Core.Admin changes their own access", async () => {
    const self = await put(cookies.adminHq, ids.adminHq, { role: "Calendar.Administrator", organizationKeys: ["gcpe-headquarters", "health"] });
    expect(self.status).toBe(403);
    expect(self.body.reason).toBe("own-access");
    expect((await put(cookies.sysAdmin, ids.sysAdmin, { role: "Calendar.SysAdmin", organizationKeys: ["finance"] })).body.reason).toBe("own-access");
    expect((await put(cookies.coreAdmin, ids.coreAdmin, { role: "Calendar.SysAdmin", organizationKeys: ["gcpe-headquarters"] })).status).toBe(200);
  });

  it("a Calendar role needs a ministry; clearing the role doesn't; ministries are replaced, not merged", async () => {
    await resetTarget();
    const none = await put(cookies.coreAdmin, targetId, { role: "Calendar.Editor", organizationKeys: [] });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body.issues)).toContain("choose at least one ministry for a Calendar role");
    expect((await put(cookies.coreAdmin, targetId, { role: "Calendar.Editor", organizationKeys: ["health", "finance", "health"] })).body.organizationKeys).toEqual(["finance", "health"]);
    expect((await put(cookies.coreAdmin, targetId, { role: null, organizationKeys: [] })).body).toMatchObject({ calendarRole: null, organizationKeys: [] });
    expect((await put(cookies.coreAdmin, targetId, { role: "Calendar.Owner", organizationKeys: ["health"] })).status).toBe(400);
  });

  it("an inactive ministry can be kept but not added; an unknown one is named", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "retired", displayName: "Retired Ministry", abbreviation: "RET", sectorKeys: [] }, []);
    await resetTarget();
    await setCalendarAccess(tdb.db, SETUP, targetId, { role: "Calendar.Editor", organizationKeys: ["retired"] }, []);
    await deactivateOrganization(tdb.db, "retired", []);
    expect((await put(cookies.adminHq, targetId, { role: "Calendar.Advanced", organizationKeys: ["retired", "health"] })).status).toBe(200);

    const other = (await createUser(tdb.db, createUserSchema.parse({ email: "new.staff@example.test", displayName: "New Staff" }), [])).id;
    const added = await put(cookies.adminHq, other, { role: "Calendar.Editor", organizationKeys: ["retired", "no-such-ministry"] });
    expect(added.status).toBe(400);
    expect(added.body).toEqual({ error: "unknown or inactive ministry", keys: ["no-such-ministry", "retired"] });
  });

  it("a bearer Core.Admin with a non-UUID subject can grant", async () => {
    await resetTarget();
    const token = await mintLocalToken({ secret: LOCAL, subject: "admin", roles: ["Core.Admin"] });
    const res = await request(app).put(`/api/calendar-access/${targetId}`).set("authorization", `Bearer ${token}`).send({ role: "Calendar.SysAdmin", organizationKeys: ["gcpe-headquarters"] });
    expect(res.status).toBe(200);
  });

  it("GET lists every user's Calendar access to the three admin roles only; the grant takes effect on the next request", async () => {
    expect((await request(app).get("/api/calendar-access").set("cookie", cookies.editor)).status).toBe(403);
    const list = await request(app).get("/api/calendar-access").set("cookie", cookies.adminHealth);
    expect(list.status).toBe(200);
    expect(list.body.find((u: { id: string }) => u.id === ids.adminMedia)).toEqual({
      id: ids.adminMedia,
      email: "adminmedia@example.test",
      displayName: "adminMedia",
      isActive: true,
      calendarRole: "Calendar.Administrator",
      organizationKeys: ["gcpe-media-relations"],
    });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|signInMethod|NRMS\./);

    // The target's own session gains the Calendar.Administrator check as soon as it's granted.
    const targetCookie = `gcpe_session=${(await mintSession(SECRET, { id: targetId, name: "Robin Staff", email: "robin.staff@example.test", roles: [] })).token}`;
    await resetTarget();
    expect((await request(app).get("/api/calendar-access").set("cookie", targetCookie)).status).toBe(403);
    await put(cookies.coreAdmin, targetId, { role: "Calendar.Administrator", organizationKeys: ["health"] });
    expect((await request(app).get("/api/calendar-access").set("cookie", targetCookie)).status).toBe(200);
  });

  it("404s an unknown or malformed user id", async () => {
    expect((await put(cookies.coreAdmin, "00000000-0000-4000-8000-000000000000", { role: null, organizationKeys: [] })).status).toBe(404);
    expect((await put(cookies.coreAdmin, "not-a-uuid", { role: null, organizationKeys: [] })).status).toBe(404);
  });
  it("compares the actor with the stored id, so an Administrator can't reach their own access by changing the id's case", async () => {
    const before = (await userEvents(ids.adminHq)).length;
    const res = await put(cookies.adminHq, ids.adminHq.toUpperCase(), { role: "Calendar.SysAdmin", organizationKeys: ["gcpe-headquarters"] });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "you can't change your own Calendar access", reason: "own-access" });
    expect(await userEvents(ids.adminHq)).toHaveLength(before);
    // The same id in another case still names the same account for everyone else.
    await resetTarget();
    const other = await put(cookies.adminHq, targetId.toUpperCase(), { role: "Calendar.Editor", organizationKeys: ["health"] });
    expect(other.status).toBe(200);
    expect(other.body.id).toBe(targetId);
  });

  /** Holds a lock in another transaction until released, the way a concurrent writer would. */
  function holding(lock: (tx: Tx) => Promise<unknown>) {
    let open!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const ready = new Promise<void>((r) => (acquired = r));
    const done = tdb.db.transaction(async (tx) => {
      await lock(tx);
      acquired();
      await gate;
    });
    return {
      ready,
      release: async () => {
        open();
        await done;
      },
    };
  }
  /** Starts a request and reports whether it finished while a lock was still held. */
  async function stillWaiting(req: Promise<request.Response>): Promise<{ waited: boolean; res: () => Promise<request.Response> }> {
    let settled = false;
    const p = req.then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 300));
    return { waited: !settled, res: () => p };
  }

  it("waits for another writer of the same user, whatever case the id is sent in", async () => {
    await resetTarget();
    const h = holding((tx) => lockAggregate(tx, userAggregateId(targetId)));
    await h.ready;
    const pending = await stillWaiting(put(cookies.coreAdmin, targetId.toUpperCase(), { role: "Calendar.Editor", organizationKeys: ["health"] })).finally(h.release);
    expect(pending.waited).toBe(true);
    expect((await pending.res()).status).toBe(200);
  });

  it("checks a ministry in the state a concurrent change commits, not the state it read before", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "closing", displayName: "Closing Ministry", abbreviation: "CLS", sectorKeys: [] }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "promoted", displayName: "Promoted Office", abbreviation: "PRO", sectorKeys: [] }, []);
    await resetTarget();

    // Deactivated while the grant waits: it may no longer be added.
    const closing = holding(async (tx) => {
      await lockAggregate(tx, orgAggregateId("closing"));
      await tx.update(organizations).set({ isActive: false }).where(eq(organizations.key, "closing"));
    });
    await closing.ready;
    const added = await stillWaiting(put(cookies.coreAdmin, targetId, { role: "Calendar.Editor", organizationKeys: ["closing"] })).finally(closing.release);
    expect(added.waited).toBe(true);
    expect((await added.res()).body).toEqual({ error: "unknown or inactive ministry", keys: ["closing"] });

    // Made HQ while the grant waits: a non-HQ Administrator may no longer add it.
    const promoted = holding(async (tx) => {
      await lockAggregate(tx, orgAggregateId("promoted"));
      await tx.update(organizations).set({ isHq: true }).where(eq(organizations.key, "promoted"));
    });
    await promoted.ready;
    const hq = await stillWaiting(put(cookies.adminHealth, targetId, { role: "Calendar.Editor", organizationKeys: ["promoted"] })).finally(promoted.release);
    expect(hq.waited).toBe(true);
    expect((await hq.res()).body.reason).toBe("hq-organization");
  });

  it("a non-HQ Administrator can't change an HQ user's access, even to take the HQ ministry away; an HQ Administrator can", async () => {
    await resetTarget();
    await setCalendarAccess(tdb.db, SETUP, targetId, { role: "Calendar.ReadOnly", organizationKeys: ["gcpe-headquarters", "health"] }, []);
    const before = (await userEvents(targetId)).length;
    const refused = await put(cookies.adminHealth, targetId, { role: "Calendar.ReadOnly", organizationKeys: ["health"] });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "only an HQ Administrator, a System Administrator or a Core admin can change the Calendar access of someone with an HQ ministry", reason: "hq-target" });
    expect(await userEvents(targetId)).toHaveLength(before);
    const cleared = await put(cookies.adminHealth, targetId, { role: null, organizationKeys: [] });
    expect(cleared.body.reason).toBe("hq-target");

    const allowed = await put(cookies.adminMedia, targetId, { role: "Calendar.ReadOnly", organizationKeys: ["health"] });
    expect(allowed.status).toBe(200);
    expect(allowed.body.organizationKeys).toEqual(["health"]);
  });

  it("an organization is HQ when the database says so, not by its name", async () => {
    await resetTarget();
    await setOrganizationHq(tdb.db, "finance", true, []);
    try {
      expect((await put(cookies.adminHealth, targetId, { role: "Calendar.Editor", organizationKeys: ["finance"] })).body.reason).toBe("hq-organization");
      expect((await put(cookies.adminMedia, targetId, { role: "Calendar.Editor", organizationKeys: ["finance"] })).status).toBe(200);
    } finally {
      await setOrganizationHq(tdb.db, "finance", false, []);
    }
    await setOrganizationHq(tdb.db, "gcpe-headquarters", false, []);
    try {
      await resetTarget();
      expect((await put(cookies.adminHealth, targetId, { role: "Calendar.Editor", organizationKeys: ["gcpe-headquarters"] })).status).toBe(200);
    } finally {
      await setOrganizationHq(tdb.db, "gcpe-headquarters", true, []);
    }
  });

  it("takes the actor from the verified session: roles or ids in the body or the cookie don't count", async () => {
    await resetTarget();
    const before = (await userEvents(targetId)).length;
    const smuggled = await put(cookies.adminHealth, targetId, { role: "Calendar.SysAdmin", organizationKeys: ["health"], roles: ["Core.Admin"], id: ids.coreAdmin, actor: { id: ids.coreAdmin, roles: ["Core.Admin"] } });
    expect(smuggled.status).toBe(400);
    expect(await userEvents(targetId)).toHaveLength(before);

    // A cookie minted with more roles than the database holds gets the database's roles.
    const inflated = `gcpe_session=${(await mintSession(SECRET, { id: ids.adminHealth, name: "adminHealth", email: "adminhealth@example.test", roles: ["Core.Admin", "Calendar.SysAdmin"] })).token}`;
    expect((await put(inflated, targetId, { role: "Calendar.SysAdmin", organizationKeys: ["health"] })).body.reason).toBe("above-ceiling");
  });

  it("an actor is HQ only while their own record holds an HQ ministry; one with no record isn't", async () => {
    const leaver = await createUser(tdb.db, createUserSchema.parse({ email: "hq.leaver@example.test", displayName: "HQ Leaver" }), []);
    await setCalendarAccess(tdb.db, SETUP, leaver.id, { role: "Calendar.Administrator", organizationKeys: ["gcpe-headquarters"] }, []);
    const cookie = `gcpe_session=${(await mintSession(SECRET, { id: leaver.id, name: "HQ Leaver", email: "hq.leaver@example.test", roles: [] })).token}`;
    await resetTarget();
    expect((await put(cookie, targetId, { role: "Calendar.Editor", organizationKeys: ["office-of-the-premier"] })).status).toBe(200);

    await setCalendarAccess(tdb.db, SETUP, leaver.id, { role: "Calendar.Administrator", organizationKeys: ["health"] }, []);
    await resetTarget();
    expect((await put(cookie, targetId, { role: "Calendar.Editor", organizationKeys: ["office-of-the-premier"] })).body.reason).toBe("hq-organization");

    // A service token has no user record, so no ministries: it is never HQ.
    const token = await mintLocalToken({ secret: LOCAL, subject: "calendar-service", roles: ["Calendar.Administrator"] });
    const bearer = (body: object) => request(app).put(`/api/calendar-access/${targetId}`).set("authorization", `Bearer ${token}`).send(body);
    await resetTarget();
    expect((await bearer({ role: "Calendar.Editor", organizationKeys: ["gcpe-headquarters"] })).body.reason).toBe("hq-organization");
    expect((await bearer({ role: "Calendar.Editor", organizationKeys: ["health"] })).status).toBe(200);
  });

  it("refusals and 404s carry no one's details", async () => {
    await resetTarget();
    await setCalendarAccess(tdb.db, SETUP, targetId, { role: "Calendar.SysAdmin", organizationKeys: ["health"] }, []);
    const refused = await put(cookies.adminHealth, targetId, { role: null, organizationKeys: [] });
    expect(Object.keys(refused.body).sort()).toEqual(["error", "reason"]);
    expect(JSON.stringify(refused.body)).not.toMatch(/robin|example\.test|health|SysAdmin/i);
    const missing = await put(cookies.coreAdmin, "00000000-0000-4000-8000-000000000000", { role: null, organizationKeys: [] });
    expect(missing.body).toEqual({ error: "not found" });
  });
});
