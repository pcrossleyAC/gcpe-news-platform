import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
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

  it("keeps a user's Calendar role and ministries, verbatim, deduplicated and sorted", async () => {
    await projectUser(app, { id: ROBIN, email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["Health", "finance", "Health"] });
    expect((await tdb.db.select().from(users).where(eq(users.id, ROBIN)))[0]).toMatchObject({ calendarRole: "Calendar.Editor", organizationKeys: ["Health", "finance"], isActive: true });
  });

  it("stores an uppercase-GUID organization key exactly as Core sent it, through upserted and deactivated (spec §5.2)", async () => {
    const key = "5F3A9C2E-7B1D-4E8A-9C6F-0A1B2C3D4E5F";
    await projectOrg(app, key, { abbreviation: "SMPL" });
    expect((await tdb.db.select().from(orgs).where(eq(orgs.key, key)))[0]).toMatchObject({ key, isActive: true });
    await sendEvent(app, envelope("core", "org.deactivated", { key }, `org:${key}`));
    expect((await tdb.db.select().from(orgs).where(eq(orgs.key, key)))[0]).toMatchObject({ key, isActive: false });
    expect(await tdb.db.select().from(orgs).where(eq(orgs.key, key.toLowerCase()))).toEqual([]);
  });

  it("two organization keys that differ only in case stay two rows, each with its own HQ flag", async () => {
    const upper = "7C2E4A1B-3D5F-4B6A-8E9C-1D2E3F4A5B6C";
    await projectOrg(app, upper, { isHq: true });
    await projectOrg(app, upper.toLowerCase(), { isHq: false });
    const rows = await tdb.db.select().from(orgs).where(inArray(orgs.key, [upper, upper.toLowerCase()]));
    expect(rows.map((r) => [r.key, r.isHq]).sort()).toEqual([[upper, true], [upper.toLowerCase(), false]]);
  });

  it("keeps a term's key in the case Core sent", async () => {
    const term = { kind: "theme", key: "Sample-Theme", displayName: "Sample theme", sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, updatedAt: "2026-10-08T17:00:00Z" };
    expect((await sendEvent(app, envelope("core", "theme.upserted", term, "theme:Sample-Theme"))).status).toBe(200);
    expect((await tdb.db.select().from(terms).where(eq(terms.key, "Sample-Theme")))[0]).toMatchObject({ kind: "theme", key: "Sample-Theme" });
    await sendEvent(app, envelope("core", "theme.deactivated", { kind: "theme", key: "Sample-Theme" }, "theme:Sample-Theme"));
    expect((await tdb.db.select().from(terms).where(eq(terms.key, "Sample-Theme")))[0]!.isActive).toBe(false);
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
