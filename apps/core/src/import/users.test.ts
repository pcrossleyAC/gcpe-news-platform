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
    );

    const result = await importLegacyUsers(tdb.db, [
      { email: "Editor@Example.TEST", displayName: "Legacy Name For Editor" },
      { email: "new.person@example.test", displayName: "New Person" },
      { email: "", displayName: "No Email" },
    ]);

    expect(result.size).toBe(2);

    const reused = result.get("editor@example.test")!;
    expect(reused.id).toBe(existing.id);
    expect(reused.displayName).toBe("Existing Editor");
    expect(await findUserByEmail(tdb.db, "editor@example.test")).toMatchObject({
      isActive: true,
      roles: ["NRMS.Editor"],
      displayName: "Existing Editor",
    });

    const created = result.get("new.person@example.test")!;
    expect(await findUserByEmail(tdb.db, "new.person@example.test")).toMatchObject({
      id: created.id,
      displayName: "New Person",
      isActive: false,
      roles: [],
    });
  });

  it("skips duplicate emails (case-insensitive), keeping only the first", async () => {
    const result = await importLegacyUsers(tdb.db, [
      { email: "dup@example.test", displayName: "First" },
      { email: "DUP@Example.test", displayName: "Second" },
    ]);
    expect(result.size).toBe(1);
    expect(result.get("dup@example.test")!.displayName).toBe("First");
  });
});
