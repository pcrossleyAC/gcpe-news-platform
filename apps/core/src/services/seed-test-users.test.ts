import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { authenticate, findUserByEmail, updateUser } from "./users";
import { seedTestUsers, TEST_USERS } from "./seed-test-users";

const pw = (n: number) => Object.fromEntries(TEST_USERS.map((u) => [u.email, `password number ${n}`]));

describe("seedTestUsers", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("creates the five test users with their roles", async () => {
    expect(await seedTestUsers(tdb.db, pw(1))).toEqual(TEST_USERS.map((u) => ({ email: u.email, action: "created" })));
    expect((await findUserByEmail(tdb.db, "editor@example.test"))?.roles).toEqual(["NRMS.Editor"]);
    expect((await findUserByEmail(tdb.db, "site-editor@example.test"))?.roles).toEqual(["NRMS.SiteEditor"]);
    expect((await findUserByEmail(tdb.db, "viewer@example.test"))?.roles).toEqual(["NRMS.Viewer"]);
    expect((await findUserByEmail(tdb.db, "nod-viewer@example.test"))?.roles).toEqual(["NoD.Viewer"]);
    expect((await findUserByEmail(tdb.db, "nod-editor@example.test"))?.roles).toEqual(["NoD.Editor"]);
  });

  it("re-running resets passwords and roles and reactivates", async () => {
    const viewer = (await findUserByEmail(tdb.db, "viewer@example.test"))!;
    await updateUser(tdb.db, viewer.id, { isActive: false });
    expect(await seedTestUsers(tdb.db, pw(2))).toEqual(TEST_USERS.map((u) => ({ email: u.email, action: "updated" })));
    expect(await authenticate(tdb.db, "viewer@example.test", "password number 1")).toBeNull();
    expect(await authenticate(tdb.db, "viewer@example.test", "password number 2")).not.toBeNull();
  });

  it("refuses a missing or short password before changing anything", async () => {
    await expect(seedTestUsers(tdb.db, { "editor@example.test": "short" })).rejects.toThrow(/at least 12 characters/);
  });
});
