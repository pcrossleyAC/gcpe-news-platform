import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { authenticate, findUserByEmail, updateUser } from "./users";
import { upsertOrganization } from "./organizations";
import { seedTestUsers, TEST_USERS } from "./seed-test-users";

const pw = (n: number) => Object.fromEntries(TEST_USERS.map((u) => [u.email, `password number ${n}`]));

const expected = (action: "created" | "updated") =>
  TEST_USERS.map((u) => ({ email: u.email, action, ...(u.calendar ? { calendar: "skipped", missingOrganizations: [...u.calendar.organizationKeys] } : {}) }));

describe("seedTestUsers", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("creates the test users with their roles", async () => {
    expect(await seedTestUsers(tdb.db, pw(1))).toEqual(expected("created"));
    expect((await findUserByEmail(tdb.db, "editor@example.test"))?.roles).toEqual(["NRMS.Editor"]);
    expect((await findUserByEmail(tdb.db, "site-editor@example.test"))?.roles).toEqual(["NRMS.SiteEditor"]);
    expect((await findUserByEmail(tdb.db, "viewer@example.test"))?.roles).toEqual(["NRMS.Viewer"]);
    expect((await findUserByEmail(tdb.db, "nod-viewer@example.test"))?.roles).toEqual(["NoD.Viewer"]);
    expect((await findUserByEmail(tdb.db, "nod-editor@example.test"))?.roles).toEqual(["NoD.Editor"]);
  });

  it("re-running resets passwords and roles and reactivates", async () => {
    const viewer = (await findUserByEmail(tdb.db, "viewer@example.test"))!;
    await updateUser(tdb.db, viewer.id, { isActive: false }, []);
    expect(await seedTestUsers(tdb.db, pw(2))).toEqual(expected("updated"));
    expect(await authenticate(tdb.db, "viewer@example.test", "password number 1")).toBeNull();
    expect(await authenticate(tdb.db, "viewer@example.test", "password number 2")).not.toBeNull();
  });

  it("refuses a missing or short password before changing anything", async () => {
    await expect(seedTestUsers(tdb.db, { "editor@example.test": "short" })).rejects.toThrow(/at least 12 characters/);
  });

  it("skips Calendar access when an organization is missing, and grants it on a re-run", async () => {
    const first = await seedTestUsers(tdb.db, pw(3));
    expect(first.find((r) => r.email === "cal-admin@example.test")).toMatchObject({ calendar: "skipped", missingOrganizations: ["health"] });
    await upsertOrganization(tdb.db, healthOrg, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sectorKeys: [] }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true }, []);
    const second = await seedTestUsers(tdb.db, pw(4));
    for (const e of ["cal-admin", "cal-sysadmin", "cal-hq-admin", "cal-editor", "cal-readonly"]) {
      expect(second.find((r) => r.email === `${e}@example.test`)?.calendar).toBe("set");
    }
    const admin = await findUserByEmail(tdb.db, "cal-admin@example.test");
    expect(admin).toMatchObject({ calendarRole: "Calendar.Administrator", organizationKeys: ["health"], roles: [] });
    expect((await findUserByEmail(tdb.db, "cal-hq-admin@example.test"))!.organizationKeys).toEqual(["gcpe-headquarters"]);
  });

  it("users without a Calendar entry report no calendar field", async () => {
    const r = await seedTestUsers(tdb.db, pw(5));
    expect(r.find((x) => x.email === "editor@example.test")).not.toHaveProperty("calendar");
  });
});
