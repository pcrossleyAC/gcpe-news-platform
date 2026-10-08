import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, envelope, projectOrg, projectUser, sendEvent } from "../test/helpers";
import { orgs, terms, users } from "./db/schema";
import { needsReferenceData } from "./projections";

const ROBIN = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b";

describe("Core projections", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
  });
  afterAll(() => tdb.drop());

  it("needs reference data until the first organization arrives", async () => {
    expect(await needsReferenceData(tdb.db)).toBe(true);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    expect(await needsReferenceData(tdb.db)).toBe(false);
  });

  it("keeps an organization's HQ flag and active state, and org.deactivated deactivates it", async () => {
    await projectOrg(app, "gcpe-headquarters", { isHq: true, abbreviation: "GCPEHQ" });
    expect((await tdb.db.select().from(orgs).where(eq(orgs.key, "gcpe-headquarters")))[0]).toMatchObject({ isHq: true, isActive: true, abbreviation: "GCPEHQ" });
    await sendEvent(app, envelope("core", "org.deactivated", { key: "gcpe-headquarters" }, "org:gcpe-headquarters"));
    expect((await tdb.db.select().from(orgs).where(eq(orgs.key, "gcpe-headquarters")))[0]!.isActive).toBe(false);
  });

  it("keeps sectors, themes and tags, and ignores services", async () => {
    const term = (kind: string, key: string) => ({ kind, key, displayName: key, sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, updatedAt: "2026-10-08T17:00:00Z" });
    for (const kind of ["sector", "theme", "tag", "service"]) {
      expect((await sendEvent(app, envelope("core", `${kind}.upserted`, term(kind, `sample-${kind}`), `${kind}:sample-${kind}`))).status).toBe(200);
    }
    expect((await tdb.db.select().from(terms)).map((t) => t.kind).sort()).toEqual(["sector", "tag", "theme"]);
    await sendEvent(app, envelope("core", "tag.deactivated", { kind: "tag", key: "sample-tag" }, "tag:sample-tag"));
    expect((await tdb.db.select().from(terms).where(eq(terms.key, "sample-tag")))[0]!.isActive).toBe(false);
  });

  it("keeps a user's Calendar role and ministries, lowercased, deduplicated and sorted", async () => {
    await projectUser(app, { id: ROBIN, email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["Health", "finance", " health "] });
    expect((await tdb.db.select().from(users).where(eq(users.id, ROBIN)))[0]).toMatchObject({ calendarRole: "Calendar.Editor", organizationKeys: ["finance", "health"], isActive: true });
  });

  it("ignores Core events it has no use for, and refuses a user.upserted from any other source", async () => {
    expect((await sendEvent(app, envelope("core", "release.published", {}, "release:x"))).status).toBe(400); // fails the contract, never reaches a handler
    const fromNrms = await sendEvent(app, envelope("nrms", "user.upserted", { id: ROBIN, email: null, displayName: "X", isActive: true, calendarRole: "Calendar.SysAdmin", organizationKeys: [] }, `user:${ROBIN}`));
    expect(fromNrms.body.outcome).toBe("ignored");
    expect((await tdb.db.select().from(users).where(eq(users.id, ROBIN)))[0]!.calendarRole).toBe("Calendar.Editor");
  });

  it("a redelivered or out-of-order user.upserted never restores a revoked grant", async () => {
    const KIM = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    const record = { id: KIM, email: "kim.imported@example.test", displayName: "Kim Imported", isActive: true, organizationKeys: ["health"] };
    const granted = envelope("core", "user.upserted", { ...record, calendarRole: "Calendar.Administrator" }, `user:${KIM}`);
    const revoked = envelope("core", "user.upserted", { ...record, calendarRole: null }, `user:${KIM}`);
    expect((await sendEvent(app, revoked)).body.outcome).toBe("applied");
    expect((await sendEvent(app, granted)).body.outcome).toBe("stale");
    expect((await sendEvent(app, revoked)).body.outcome).toBe("duplicate");
    expect((await tdb.db.select().from(users).where(eq(users.id, KIM)))[0]!.calendarRole).toBeNull();
  });
});
