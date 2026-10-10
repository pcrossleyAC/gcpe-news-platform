import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { createUser, createUserSchema, findUserByEmail } from "../services/users";
import { importLegacyUsers } from "./users";

describe("importLegacyUsers", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("reuses an existing active user unchanged, creates a new one inactive with no roles, and skips an empty email", async () => {
    const existing = await createUser(
      tdb.db,
      createUserSchema.parse({ email: "editor@example.test", displayName: "Existing Editor", roles: ["NRMS.Editor"] }),
      [],
    );

    const { users, skipped } = await importLegacyUsers(tdb.db, [
      { email: "Editor@Example.TEST", displayName: "Legacy Name For Editor" },
      { email: "new.person@example.test", displayName: "New Person" },
      { email: "", displayName: "No Email" },
    ]);

    expect(users.size).toBe(2);

    const reused = users.get("editor@example.test")!;
    expect(reused.id).toBe(existing.id);
    expect(reused.displayName).toBe("Existing Editor");
    expect(await findUserByEmail(tdb.db, "editor@example.test")).toMatchObject({
      isActive: true,
      roles: ["NRMS.Editor"],
      displayName: "Existing Editor",
    });

    const created = users.get("new.person@example.test")!;
    expect(await findUserByEmail(tdb.db, "new.person@example.test")).toMatchObject({
      id: created.id,
      displayName: "New Person",
      isActive: false,
      roles: [],
    });

    expect(skipped).toEqual([{ email: "", displayName: "No Email", reason: "empty email" }]);
  });

  it("skips duplicate emails (case-insensitive), keeping only the first", async () => {
    const { users, skipped } = await importLegacyUsers(tdb.db, [
      { email: "dup@example.test", displayName: "First" },
      { email: "DUP@Example.test", displayName: "Second" },
    ]);
    expect(users.size).toBe(1);
    expect(users.get("dup@example.test")!.displayName).toBe("First");
    expect(skipped).toEqual([{ email: "DUP@Example.test", displayName: "Second", reason: "duplicate email" }]);
  });

  it("truncates a display name over 100 chars before creating the user", async () => {
    const longName = "A".repeat(130);
    const { users, skipped } = await importLegacyUsers(tdb.db, [{ email: "long-name@example.test", displayName: longName }]);
    expect(skipped).toEqual([]);
    const created = users.get("long-name@example.test")!;
    expect(created.displayName).toHaveLength(100);
    expect(created.displayName).toBe("A".repeat(100));
    expect(await findUserByEmail(tdb.db, "long-name@example.test")).toMatchObject({ displayName: "A".repeat(100), isActive: false });
  });

  it("falls back to the email's local part when the legacy display name is blank", async () => {
    const { users, skipped } = await importLegacyUsers(tdb.db, [{ email: "jane.doe@example.test", displayName: "   " }]);
    expect(skipped).toEqual([]);
    expect(users.get("jane.doe@example.test")!.displayName).toBe("jane.doe");
  });

  it("skips a row whose email fails schema validation, with a reason", async () => {
    const { users, skipped } = await importLegacyUsers(tdb.db, [{ email: "not-an-email", displayName: "Someone" }]);
    expect(users.size).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ email: "not-an-email", displayName: "Someone" });
    expect(skipped[0]!.reason.length).toBeGreaterThan(0);
    expect(await findUserByEmail(tdb.db, "not-an-email")).toBeNull();
  });
});
