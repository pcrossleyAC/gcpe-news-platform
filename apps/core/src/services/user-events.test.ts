import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { organizations, roleGrants, userOrganizations } from "../db/schema";
import { upsertOrganization } from "./organizations";
import { republishAll } from "./republish";
import { createUser, createUserSchema, getUser, sessionUserFor, setPassword, setRoles, updateUser } from "./users";

const subs: SubscriberConfig[] = [{ name: "calendar", url: "http://x/events", secret: "s", types: ["user.upserted"] }];

describe("user.upserted from Core", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
    await upsertOrganization(tdb.db, healthOrg, []);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  async function userEvents(id: string): Promise<UserRecord[]> {
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`)).orderBy(asc(outboxEvents.sequence));
    for (const r of rows) expect(r.type).toBe("user.upserted");
    return rows.map((r) => (r.envelope as { data: UserRecord }).data);
  }

  async function giveCalendarAccess(id: string, role: string, orgKey: string) {
    const [org] = await tdb.db.select().from(organizations).where(eq(organizations.key, orgKey));
    await tdb.db.insert(roleGrants).values({ userId: id, role });
    await tdb.db.insert(userOrganizations).values({ userId: id, organizationId: org!.id });
  }

  it("create, rename, deactivate and a flat-roles save each emit the whole record; a password change doesn't", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "robin.staff@example.test", displayName: "Robin Staff", roles: ["NRMS.Viewer"] }), subs);
    await updateUser(tdb.db, u.id, { displayName: "Robin S. Staff" }, subs);
    await updateUser(tdb.db, u.id, { isActive: false }, subs);
    await setRoles(tdb.db, u.id, ["NRMS.Editor"], subs);
    await setPassword(tdb.db, u.id, "a long enough password");
    const events = await userEvents(u.id);
    expect(events.map((e) => [e.displayName, e.isActive])).toEqual([
      ["Robin Staff", true],
      ["Robin S. Staff", true],
      ["Robin S. Staff", false],
      ["Robin S. Staff", false],
    ]);
    expect(events[0]).toEqual({ id: u.id, email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: null, organizationKeys: [] });
    expect(JSON.stringify(events)).not.toMatch(/scrypt|passwordHash|password/);
  });

  it("reports the Calendar role apart from the flat roles; the session and the event carry it", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "cal.one@example.test", displayName: "Cal One", roles: ["NRMS.Viewer"] }), subs);
    await giveCalendarAccess(u.id, "Calendar.Editor", "health");
    const view = (await getUser(tdb.db, u.id))!;
    expect(view.roles).toEqual(["NRMS.Viewer"]);
    expect(view.calendarRole).toBe("Calendar.Editor");
    expect(view.organizationKeys).toEqual(["health"]);
    expect((await sessionUserFor(tdb.db, u.id))!.roles).toEqual(["Calendar.Editor", "NRMS.Viewer"]);
  });

  it("a flat-roles save keeps the Calendar role and ministries", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "keeps.calendar@example.test", displayName: "Keeps Calendar", roles: ["NRMS.Viewer"] }), subs);
    await giveCalendarAccess(u.id, "Calendar.Advanced", "health");
    const after = await setRoles(tdb.db, u.id, ["NoD.Viewer", "NRMS.Editor"], subs);
    expect(after.roles).toEqual(["NoD.Viewer", "NRMS.Editor"]);
    expect(after.calendarRole).toBe("Calendar.Advanced");
    expect(after.organizationKeys).toEqual(["health"]);
    expect((await userEvents(u.id)).at(-1)).toMatchObject({ calendarRole: "Calendar.Advanced", organizationKeys: ["health"] });
    await expect(setRoles(tdb.db, u.id, ["Calendar.SysAdmin"], subs)).rejects.toThrow(/Calendar role/);
  });

  it("only subscribers of user.upserted get a delivery", async () => {
    const orgOnly: SubscriberConfig[] = [{ name: "nrms", url: "http://x/events", secret: "s", types: ["org.upserted"] }];
    const a = await createUser(tdb.db, createUserSchema.parse({ email: "delivered@example.test", displayName: "Delivered" }), subs);
    const b = await createUser(tdb.db, createUserSchema.parse({ email: "not-delivered@example.test", displayName: "Not Delivered" }), orgOnly);
    const deliveriesFor = async (id: string) => {
      const [event] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`));
      return (await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, event!.id))).map((d) => d.subscriber);
    };
    expect(await deliveriesFor(a.id)).toEqual(["calendar"]);
    expect(await deliveriesFor(b.id)).toEqual([]);
  });

  it("republishAll re-emits every user with their current record", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "republished@example.test", displayName: "Republished" }), subs);
    const before = (await userEvents(u.id)).length;
    await republishAll(tdb.db, subs);
    const events = await userEvents(u.id);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual(toRecordOf(await getUser(tdb.db, u.id)));
  });
});

function toRecordOf(u: Awaited<ReturnType<typeof getUser>>): UserRecord {
  return { id: u!.id, email: u!.email, displayName: u!.displayName, isActive: u!.isActive, calendarRole: u!.calendarRole, organizationKeys: u!.organizationKeys };
}
