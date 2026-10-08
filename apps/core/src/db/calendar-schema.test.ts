import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { upsertOrganization } from "../services/organizations";
import { organizations, roleGrants, userLegacyIds, userOrganizations, users } from "./schema";

describe("Calendar access schema", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const pgCode = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code;

  it("allows one Calendar role per user, beside any flat roles", async () => {
    const [u] = await tdb.db.insert(users).values({ email: "one-role@example.test", displayName: "One Role" }).returning();
    await tdb.db.insert(roleGrants).values([
      { userId: u!.id, role: "NRMS.Editor" },
      { userId: u!.id, role: "Calendar.Editor" },
    ]);
    const second = await tdb.db.insert(roleGrants).values({ userId: u!.id, role: "Calendar.Advanced" }).catch((e: unknown) => e);
    expect(pgCode(second)).toBe("23505");
  });

  it("refuses an active user without an email; any number of inactive no-email users coexist", async () => {
    const active = await tdb.db.insert(users).values({ email: null, displayName: "Active No Email", isActive: true }).catch((e: unknown) => e);
    expect(pgCode(active)).toBe("23514");
    await tdb.db.insert(users).values([
      { email: null, displayName: "Kim Imported", isActive: false },
      { email: null, displayName: "Lee Imported", isActive: false },
    ]);
    expect((await tdb.db.select().from(users).where(eq(users.isActive, false))).filter((u) => u.email === null)).toHaveLength(2);
  });

  it("organizations default to not HQ; ministries go with the user; legacy ids are unique per system", async () => {
    await upsertOrganization(tdb.db, healthOrg, []);
    const [org] = await tdb.db.select().from(organizations).where(eq(organizations.key, "health"));
    expect(org!.isHq).toBe(false);

    const [u] = await tdb.db.insert(users).values({ email: "ministries@example.test", displayName: "Has Ministries" }).returning();
    await tdb.db.insert(userOrganizations).values({ userId: u!.id, organizationId: org!.id });
    await tdb.db.insert(userLegacyIds).values({ system: "calendar", legacyId: "1042", userId: u!.id });
    const dup = await tdb.db.insert(userLegacyIds).values({ system: "calendar", legacyId: "1042", userId: u!.id }).catch((e: unknown) => e);
    expect(pgCode(dup)).toBe("23505");

    await tdb.db.delete(users).where(eq(users.id, u!.id));
    expect(await tdb.db.select().from(userOrganizations).where(eq(userOrganizations.userId, u!.id))).toEqual([]);
    expect(await tdb.db.select().from(userLegacyIds).where(eq(userLegacyIds.userId, u!.id))).toEqual([]);
  });
});
