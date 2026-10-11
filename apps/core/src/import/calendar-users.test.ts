import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { seedCoreForImport } from "../../../calendar/test/legacy-calendar-fixture";
import { roleGrants, userLegacyIds, users } from "../db/schema";
import { getUser } from "../services/users";
import { applyCalendarUsers, planCalendarUsers } from "./calendar-users";
import type { CalendarUserCandidate } from "./legacy-keys";
import { loadLegacyKeys } from "./legacy-keys";

let tdb: TestDatabase;
beforeAll(async () => { tdb = await createCoreTestDb(); });
afterAll(async () => { await tdb.drop(); });
beforeEach(async () => {
  await tdb.db.execute(sql`TRUNCATE users, organizations, terms, outbox_events, outbox_deliveries, aggregate_sequences CASCADE`);
  await seedCoreForImport(tdb.db);
});
const SUBS = [{ name: "calendar", url: "https://unused.example.test", secret: "unused-000000000000000000000000000000", types: ["user.upserted"] }];
const deliveries = async () => Number((await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_deliveries WHERE subscriber = 'calendar'`)).rows[0]!.n);
const cand = (legacyId: number, email: string | null, over: Partial<CalendarUserCandidate> = {}): CalendarUserCandidate =>
  ({ legacyId, email, displayName: `Sample User ${legacyId}`, isActive: true, calendarRole: "Calendar.Editor", organizationIds: [], lastUpdated: 0, ...over });
const run = async (c: CalendarUserCandidate[]) => applyCalendarUsers(tdb.db, await planCalendarUsers(tdb.db, c), SUBS);

describe("Calendar users into Core (spec addendum §12.1 step 1, R12, C144)", () => {
  it("creates a new user with legacy's role, ministries and legacy id, and tells subscribers once", async () => {
    const fin = (await loadLegacyKeys(tdb.db)).org("0F000000-0000-4000-8000-000000000001")!;
    const r = await run([cand(31, " New.Person@Example.test ", { organizationIds: [fin.id] })]);
    const u = (await getUser(tdb.db, r.userIdOf.get(31)!))!;
    expect(u).toMatchObject({ email: "new.person@example.test", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["finance"] });
    expect(r.created).toBe(1);
    expect(await deliveries()).toBe(1);
  });

  it("imports a user with no email, or an invalid one, as inactive with no email, keeping their role", async () => {
    const r = await run([cand(32, null), cand(33, "not-an-address")]);
    for (const id of [32, 33]) expect(await getUser(tdb.db, r.userIdOf.get(id)!)).toMatchObject({ email: null, isActive: false, calendarRole: "Calendar.Editor" });
    expect((await planCalendarUsers(tdb.db, [cand(33, "not-an-address")])).invalidEmails).toEqual([33]);
  });

  it("maps duplicate emails to one user, taking role and ministries from the active row last updated", async () => {
    const r = await run([
      cand(34, "dup@example.test", { isActive: true, calendarRole: "Calendar.Advanced", lastUpdated: 1 }),
      cand(35, "DUP@example.test", { isActive: false, calendarRole: "Calendar.Administrator", lastUpdated: 2 }),
    ]);
    expect(r.userIdOf.get(34)).toBe(r.userIdOf.get(35));
    expect(r.groups).toEqual([expect.objectContaining({ legacyIds: [34, 35], representativeLegacyId: 34 })]);
    expect(await getUser(tdb.db, r.userIdOf.get(34)!)).toMatchObject({ isActive: true, calendarRole: "Calendar.Advanced" });
  });

  it("links an existing user by email: keeps their roles and active flag, adds Calendar access only when they have none", async () => {
    const r = await run([cand(11, "avery.sample@example.test", { calendarRole: "Calendar.Editor" })]);
    expect(await getUser(tdb.db, r.userIdOf.get(11)!)).toMatchObject({ displayName: "Avery Core", isActive: true, roles: ["NRMS.Editor"], calendarRole: "Calendar.Editor" });
    expect(r.linked).toBe(1);
  });

  it("never overwrites Calendar access Core already holds", async () => {
    const first = await run([cand(11, "avery.sample@example.test", { calendarRole: "Calendar.Editor" })]);
    await tdb.db.delete(userLegacyIds);
    const again = await run([cand(11, "avery.sample@example.test", { calendarRole: "Calendar.SysAdmin" })]);
    expect(again.accessKept).toEqual([first.userIdOf.get(11)]);
    expect((await getUser(tdb.db, first.userIdOf.get(11)!))!.calendarRole).toBe("Calendar.Editor");
  });

  it("activates a role-less inactive placeholder when legacy says active, but never a user with any role", async () => {
    const r = await run([cand(12, "blake.sample@example.test", { calendarRole: "Calendar.SysAdmin" })]);
    expect(await getUser(tdb.db, r.userIdOf.get(12)!)).toMatchObject({ isActive: true, calendarRole: "Calendar.SysAdmin" });
    expect(r.activated).toEqual([r.userIdOf.get(12)]);
  });

  it("a re-run matches by legacy id and changes nothing: no row, no grant, no event", async () => {
    const c = [cand(11, "avery.sample@example.test"), cand(36, null), cand(37, "new.two@example.test")];
    await run(c);
    const before = { d: await deliveries(), u: await tdb.db.select().from(users), g: await tdb.db.select().from(roleGrants) };
    const again = await run(c);
    expect(again.unchanged).toBe(3);
    expect(await deliveries()).toBe(before.d);
    expect(await tdb.db.select().from(users)).toEqual(before.u);
    expect(await tdb.db.select().from(roleGrants)).toEqual(before.g);
  });
});
