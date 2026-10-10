import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser } from "../test/helpers";
import { userProfiles } from "./db/schema";
import { CalendarUserNotFoundError, getCalendarUser, listCalendarUsers, NotUsersMinistryError, profileSchema, saveProfile, setCommContactRank } from "./users";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("Calendar users", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    await projectOrg(app, "finance", { abbreviation: "FIN" });
    await projectUser(app, { id: id(1), email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health", "finance"] });
    await projectUser(app, { id: id(2), email: null, displayName: "Kim Imported", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
    await projectUser(app, { id: id(3), email: "sam.noaccess@example.test", displayName: "Sam Noaccess", isActive: true, calendarRole: null, organizationKeys: [] });
  });
  afterAll(() => tdb.drop());

  it("lists active users with a Calendar role, one row per ministry, with that ministry's rank (C165)", async () => {
    await setCommContactRank(tdb.db, id(1), "health", 1);
    const rows = await listCalendarUsers(tdb.db, { inactive: false, noAccess: false });
    expect(rows.map((r) => [r.displayName, r.ministryAbbreviation, r.rank])).toEqual([
      ["Robin Staff", "FIN", null],
      ["Robin Staff", "HLTH", 1],
    ]);
  });

  it("adds inactive users and users without Calendar access when asked", async () => {
    const names = (await listCalendarUsers(tdb.db, { inactive: true, noAccess: true })).map((r) => r.displayName);
    expect(names).toContain("Kim Imported");
    expect(names).toContain("Sam Noaccess");
  });

  it("detail has the profile and comm contacts; a missing profile reads as empty", async () => {
    const d = await getCalendarUser(tdb.db, id(1));
    expect(d.user).toMatchObject({ displayName: "Robin Staff", ministryKeys: ["finance", "health"], role: "Calendar.Editor" });
    expect(d.profile).toEqual({ phone: null, mobile: null, jobTitle: null, description: null });
    expect(d.commContacts).toEqual([{ ministryKey: "health", rank: 1, isActive: true }]);
  });

  it("saves contact details; blank becomes empty", async () => {
    await saveProfile(tdb.db, id(1), profileSchema.parse({ phone: "250-555-0100", mobile: "", jobTitle: "Sample title", description: "" }));
    expect((await getCalendarUser(tdb.db, id(1))).profile).toEqual({ phone: "250-555-0100", mobile: null, jobTitle: "Sample title", description: null });
  });

  it("phone is free text up to 20 characters, with no format check", () => {
    expect(profileSchema.safeParse({ phone: "ext. 4421", mobile: null, jobTitle: null, description: null }).success).toBe(true);
    expect(profileSchema.safeParse({ phone: "(250) 555-0100", mobile: null, jobTitle: null, description: null }).success).toBe(true);
    const tooLong = profileSchema.safeParse({ phone: "x".repeat(21), mobile: null, jobTitle: null, description: null });
    expect(tooLong.success).toBe(false);
    expect(tooLong.success ? undefined : tooLong.error.issues[0]!.message).toBe("at most 20 characters");
  });

  it("mobile must be blank or legacy's exact 12 characters of digits and hyphens", () => {
    expect(profileSchema.safeParse({ phone: null, mobile: "250-555-0100", jobTitle: null, description: null }).success).toBe(true);
    expect(profileSchema.safeParse({ phone: null, mobile: "", jobTitle: null, description: null }).success).toBe(true);
    for (const mobile of ["(250) 555-0100", "250 555 0100", "2505550100"]) {
      const r = profileSchema.safeParse({ phone: null, mobile, jobTitle: null, description: null });
      expect(r.success).toBe(false);
      expect(r.success ? undefined : r.error.issues[0]!.message).toBe("use 12 digits and hyphens, like 250-555-0100");
    }
  });

  it("'not a comm contact' deactivates the row and keeps it", async () => {
    await setCommContactRank(tdb.db, id(1), "health", null);
    expect((await getCalendarUser(tdb.db, id(1))).commContacts).toEqual([{ ministryKey: "health", rank: 1, isActive: false }]);
    await setCommContactRank(tdb.db, id(1), "health", 4);
    expect((await getCalendarUser(tdb.db, id(1))).commContacts).toEqual([{ ministryKey: "health", rank: 4, isActive: true }]);
  });

  it("a rank for a ministry the projection doesn't show is refused with what to do", async () => {
    await expect(setCommContactRank(tdb.db, id(1), "education", 2)).rejects.toBeInstanceOf(NotUsersMinistryError);
  });

  it("uses the ministry key exactly as given, with no case-folding", async () => {
    const app = createTestApp(tdb.db);
    const ministryKey = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
    await projectUser(app, { id: id(4), email: "guid.holder@example.test", displayName: "Guid Holder", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: [ministryKey] });
    const contacts = await setCommContactRank(tdb.db, id(4), ministryKey, 2);
    expect(contacts).toEqual([{ ministryKey, rank: 2, isActive: true }]);
    await expect(setCommContactRank(tdb.db, id(4), ministryKey.toLowerCase(), 3)).rejects.toBeInstanceOf(NotUsersMinistryError);
  });

  it("an unknown or malformed user id is 404, and no profile is written", async () => {
    await expect(getCalendarUser(tdb.db, id(99))).rejects.toBeInstanceOf(CalendarUserNotFoundError);
    await expect(getCalendarUser(tdb.db, "not-a-uuid")).rejects.toBeInstanceOf(CalendarUserNotFoundError);
    await expect(saveProfile(tdb.db, id(99), profileSchema.parse({ phone: null, mobile: null, jobTitle: null, description: null }))).rejects.toBeInstanceOf(CalendarUserNotFoundError);
    expect(await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, id(99)))).toEqual([]);
  });
});
