import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { users } from "../db/schema";
import {
  adminEmails,
  authenticate,
  CannotActivateWithoutEmailError,
  createUser,
  createUserSchema,
  findUserByEmail,
  getUser,
  listUsers,
  sessionUserFor,
  setPassword,
  setRoles,
  updateUser,
  UserExistsError,
  UserNotFoundError,
} from "./users";

const PW = "correct horse battery";

describe("users service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("creates a user with roles, normalising the email, and never exposes the hash", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "  Editor@Example.TEST ", displayName: "Test Editor", roles: ["NRMS.Editor", "NRMS.Editor"], password: PW }), []);
    expect(u).toEqual({
      id: expect.any(String),
      email: "editor@example.test",
      displayName: "Test Editor",
      isActive: true,
      signInMethod: "local",
      roles: ["NRMS.Editor"],
      calendarRole: null,
      organizationKeys: [],
    });
    expect(Object.keys(u)).not.toContain("passwordHash");
    expect(await getUser(tdb.db, u.id)).toEqual(u);
    expect(await findUserByEmail(tdb.db, "EDITOR@example.test")).toEqual(u);
    expect((await listUsers(tdb.db)).map((x) => x.email)).toContain("editor@example.test");
  });

  it("refuses a duplicate email in any case", async () => {
    await expect(createUser(tdb.db, createUserSchema.parse({ email: "EDITOR@example.test", displayName: "Dup" }), [])).rejects.toBeInstanceOf(UserExistsError);
  });

  it("rejects unknown roles and short passwords at the schema", () => {
    expect(createUserSchema.safeParse({ email: "a@example.test", displayName: "A", roles: ["NRMS.God"] }).success).toBe(false);
    expect(createUserSchema.safeParse({ email: "a@example.test", displayName: "A", password: "short" }).success).toBe(false);
  });

  it("authenticates by email in any case and with surrounding spaces", async () => {
    expect((await authenticate(tdb.db, " editor@EXAMPLE.test ", PW))?.email).toBe("editor@example.test");
    expect(await authenticate(tdb.db, "editor@example.test", "wrong password!!")).toBeNull();
    expect(await authenticate(tdb.db, "nobody@example.test", PW)).toBeNull();
  });

  it("refuses inactive users and users without a password", async () => {
    const noPw = await createUser(tdb.db, createUserSchema.parse({ email: "entra@example.test", displayName: "Entra Person" }), []);
    expect(await authenticate(tdb.db, "entra@example.test", PW)).toBeNull();
    const v = await createUser(tdb.db, createUserSchema.parse({ email: "viewer@example.test", displayName: "Viewer", roles: ["NRMS.Viewer"], password: PW }), []);
    await updateUser(tdb.db, v.id, { isActive: false }, []);
    expect(await authenticate(tdb.db, "viewer@example.test", PW)).toBeNull();
    expect(await sessionUserFor(tdb.db, v.id)).toBeNull();
    expect(await sessionUserFor(tdb.db, noPw.id)).toEqual({ id: noPw.id, name: "Entra Person", email: "entra@example.test", roles: [] });
  });

  it("replaces roles, resets passwords, and 404s unknown or malformed ids", async () => {
    const u = (await findUserByEmail(tdb.db, "editor@example.test"))!;
    expect((await setRoles(tdb.db, u.id, ["NRMS.Viewer", "Core.Admin", "Core.Admin"], [])).roles).toEqual(["Core.Admin", "NRMS.Viewer"]);
    await setPassword(tdb.db, u.id, "a brand new passphrase");
    expect(await authenticate(tdb.db, "editor@example.test", PW)).toBeNull();
    expect(await authenticate(tdb.db, "editor@example.test", "a brand new passphrase")).not.toBeNull();
    await expect(setRoles(tdb.db, "00000000-0000-4000-8000-000000000000", [], [])).rejects.toBeInstanceOf(UserNotFoundError);
    expect(await getUser(tdb.db, "not-a-uuid")).toBeNull();
    expect(await sessionUserFor(tdb.db, "local:admin")).toBeNull();
  });

  it("adminEmails lists only active Core.Admin users, deduplicated and sorted", async () => {
    await createUser(tdb.db, createUserSchema.parse({ email: "zed-admin@example.test", displayName: "Zed Admin", roles: ["Core.Admin"], password: PW }), []);
    await createUser(tdb.db, createUserSchema.parse({ email: "ann-admin@example.test", displayName: "Ann Admin", roles: ["Core.Admin"], password: PW }), []);
    const inactiveAdmin = await createUser(tdb.db, createUserSchema.parse({ email: "retired-admin@example.test", displayName: "Retired Admin", roles: ["Core.Admin"], password: PW }), []);
    await updateUser(tdb.db, inactiveAdmin.id, { isActive: false }, []);
    await createUser(tdb.db, createUserSchema.parse({ email: "non-admin@example.test", displayName: "Not Admin", roles: ["NRMS.Viewer"], password: PW }), []);

    const emails = await adminEmails(tdb.db);
    expect(emails).not.toContain("retired-admin@example.test");
    expect(emails).not.toContain("non-admin@example.test");
    expect(emails.indexOf("ann-admin@example.test")).toBeGreaterThanOrEqual(0);
    expect(emails.indexOf("zed-admin@example.test")).toBeGreaterThan(emails.indexOf("ann-admin@example.test"));
    expect(emails).toEqual([...emails].sort());
  });

  it("createUser({ isActive: false }) creates an inactive user; default stays active", async () => {
    const inactive = await createUser(tdb.db, createUserSchema.parse({ email: "legacy-import@example.test", displayName: "Legacy Import", isActive: false }), []);
    expect(inactive.isActive).toBe(false);
    expect(await findUserByEmail(tdb.db, "legacy-import@example.test")).toMatchObject({ isActive: false });

    const active = await createUser(tdb.db, createUserSchema.parse({ email: "default-active@example.test", displayName: "Default Active" }), []);
    expect(active.isActive).toBe(true);
  });

  it("refuses to reactivate a no-email user with a clear error, not a raw database error", async () => {
    const [noEmail] = await tdb.db.insert(users).values({ email: null, displayName: "No Email Import", isActive: false }).returning();
    await expect(updateUser(tdb.db, noEmail!.id, { isActive: true }, [])).rejects.toBeInstanceOf(CannotActivateWithoutEmailError);
    expect((await getUser(tdb.db, noEmail!.id))!.isActive).toBe(false);
  });
});
