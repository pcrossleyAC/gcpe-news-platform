import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createFakeSource } from "@gcpe/legacy-import";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { organizations, terms } from "../db/schema";
import { upsertOrganization } from "../services/organizations";
import { upsertTerm } from "../services/terms";
import { linkLegacyIds, readLegacyReference } from "./link-legacy-ids";
import { loadLegacyKeys } from "./legacy-keys";

const subs: SubscriberConfig[] = [{ name: "calendar", url: "http://x/events", secret: "s", types: ["*"] }];
const ministry = (Id: string, Key: string, DisplayName: string, IsActive = true) => ({
  Id, Key, SortOrder: 10, DisplayName, Abbreviation: null, IsActive,
  MinisterEmail: null, MinisterPhotoUrl: null, MinisterPageHtml: null, MinisterAddress: null, MinisterName: "Legacy minister", MinisterSummary: null,
  MinistryUrl: null, ParentKey: "health", WeekendContactNumber: null, DisplayAdditionalName: null, TwitterUsername: null, FlickrUrl: null, YoutubeUrl: null, AudioUrl: null,
  ContactUserId: null, ContactFullName: null, ContactPhone: null, ContactMobile: null, ContactEmail: null,
  SecondContactUserId: null, SecondContactFullName: null, SecondContactPhone: null, SecondContactMobile: null, SecondContactEmail: null,
});
const term = (Id: string, Key: string, IsActive = true) => ({ Id, Key, SortOrder: 0, IsActive, DisplayName: Key });
const HEALTH = "11111111-1111-1111-1111-111111111111";
const TRADE = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const SECTOR = "44444444-4444-4444-4444-444444444444";
const OLD_SECTOR = "55555555-5555-5555-5555-555555555555";

const legacy = () =>
  readLegacyReference(
    createFakeSource({
      ministries: [ministry(HEALTH.toUpperCase(), "health", "Ministry of Health (legacy name)"), ministry(TRADE, "trade", "Trade", true), ministry(OTHER, "finance", "Finance")],
      sectors: [term(SECTOR, "economy"), term(OLD_SECTOR, "education", false)],
      themes: [],
      tags: [],
    }),
  );

describe("linkLegacyIds", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.db.execute(sql`TRUNCATE organizations, terms, outbox_events, outbox_deliveries, aggregate_sequences CASCADE`);
    // Core as a test host has it: set up without legacy ids. Finance already holds another legacy id.
    await upsertOrganization(tdb.db, { ...healthOrg, displayName: "Health" }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN" }, [], { legacyId: "99999999-9999-9999-9999-999999999999" });
    await upsertTerm(tdb.db, { kind: "sector", key: "economy", displayName: "Economy", sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null } }, []);
    await tdb.db.delete(outboxEvents);
  });
  const rows = async () => ({
    orgs: (await tdb.db.select().from(organizations)).map((o) => ({ key: o.key, name: o.displayName, legacyId: o.legacyId, isActive: o.isActive, isPublic: o.isPublic, parentKey: o.parentKey, minister: o.minister.name })).sort((a, b) => a.key.localeCompare(b.key)),
    terms: (await tdb.db.select().from(terms)).map((t) => ({ key: `${t.kind}:${t.key}`, legacyId: t.legacyId, isActive: t.isActive })).sort((a, b) => a.key.localeCompare(b.key)),
  });

  it("a dry run reports and writes nothing", async () => {
    const before = await rows();
    const report = await linkLegacyIds(tdb.db, await legacy(), subs, false);
    expect(report).toEqual({
      mode: "dry-run",
      linked: { organizations: 1, terms: 1 },
      alreadyLinked: { organizations: 0, terms: 0 },
      created: { organizations: ["trade"], terms: ["sector:education"] },
      conflicts: ["ministry finance"],
      linkedByAbbreviation: [],
    });
    expect(await rows()).toEqual(before);
    expect(await tdb.db.select().from(outboxEvents)).toEqual([]);
  });

  it("links matching keys without touching content, adds the missing ones as inactive placeholders, and leaves a conflict alone", async () => {
    await linkLegacyIds(tdb.db, await legacy(), subs, true);
    const after = await rows();
    // Health keeps its own name and content; only the legacy id is new (lower-cased).
    expect(after.orgs.find((o) => o.key === "health")).toMatchObject({ name: "Health", legacyId: HEALTH, isActive: true, isPublic: true });
    expect(after.orgs.find((o) => o.key === "finance")).toMatchObject({ legacyId: "99999999-9999-9999-9999-999999999999" });
    expect(after.orgs.find((o) => o.key === "trade")).toMatchObject({ name: "Trade", legacyId: TRADE, isActive: false, isPublic: false, parentKey: null });
    expect(after.terms).toEqual([
      { key: "sector:economy", legacyId: SECTOR, isActive: true },
      { key: "sector:education", legacyId: OLD_SECTOR, isActive: false },
    ]);
    // Only the placeholders are announced to the other apps.
    expect((await tdb.db.select().from(outboxEvents)).map((e) => e.type).sort()).toEqual(["org.upserted", "sector.upserted"]);
    // The Calendar import now resolves them.
    const keys = await loadLegacyKeys(tdb.db);
    expect(keys.termKey("sector", OLD_SECTOR)).toBe("education");
  });

  it("matches a key ignoring case (legacy's GUID-shaped keys are upper-case), never adding a duplicate", async () => {
    const archived = "56429306-8c3e-4991-aeb2-1cc86f20bfdd";
    await upsertOrganization(tdb.db, { ...healthOrg, key: archived, displayName: "zzzz Archive", abbreviation: null, isActive: false }, []);
    const ref = await readLegacyReference(createFakeSource({ ministries: [ministry(archived.toUpperCase(), archived.toUpperCase(), "Archive")], sectors: [], themes: [], tags: [] }));
    const report = await linkLegacyIds(tdb.db, ref, subs, true);
    expect(report).toMatchObject({ linked: { organizations: 1 }, created: { organizations: [] } });
    const matching = (await tdb.db.select().from(organizations)).filter((o) => o.key.toLowerCase() === archived);
    expect(matching.map((o) => ({ key: o.key, legacyId: o.legacyId, name: o.displayName }))).toEqual([{ key: archived, legacyId: archived, name: "zzzz Archive" }]);
  });

  it("a ministry no key matches is linked by a unique abbreviation, never one a key matched or one already linked", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ" }, []);
    const hq = "66666666-6666-6666-6666-666666666666";
    const ref = await readLegacyReference(createFakeSource({
      ministries: [{ ...ministry(hq.toUpperCase(), hq.toUpperCase(), "GCPE HQ"), Abbreviation: "GCPEHQ" }, { ...ministry("77777777-7777-7777-7777-777777777777", "77777777-7777-7777-7777-777777777777", "Archived Health"), Abbreviation: "HLTH" }, ministry(HEALTH, "health", "Health")],
      sectors: [], themes: [], tags: [],
    }));
    const report = await linkLegacyIds(tdb.db, ref, subs, true);
    expect(report.linkedByAbbreviation).toEqual([`${hq.toUpperCase()} -> gcpe-headquarters`]);
    // "health" (HLTH) is key-matched by legacy's Health, so the archived HLTH becomes a placeholder instead.
    expect(report.created.organizations).toEqual(["77777777-7777-7777-7777-777777777777"]);
    const after = await rows();
    expect(after.orgs.find((o) => o.key === "gcpe-headquarters")).toMatchObject({ legacyId: hq, name: "GCPE Headquarters" });
    expect(after.orgs.find((o) => o.key === "health")).toMatchObject({ legacyId: HEALTH });
  });

  it("a second run changes nothing", async () => {
    await linkLegacyIds(tdb.db, await legacy(), subs, true);
    const once = await rows();
    const again = await linkLegacyIds(tdb.db, await legacy(), subs, true);
    expect(again).toMatchObject({ linked: { organizations: 0, terms: 0 }, alreadyLinked: { organizations: 2, terms: 2 }, created: { organizations: [], terms: [] } });
    expect(await rows()).toEqual(once);
  });
});
