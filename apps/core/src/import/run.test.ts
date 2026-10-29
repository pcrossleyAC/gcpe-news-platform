import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createFakeSource } from "@gcpe/legacy-import";
import { createCoreTestDb } from "../../test/helpers";
import { eq } from "drizzle-orm";
import { organizations, terms } from "../db/schema";
import { deactivateOrganization, listOrganizations, patchOrganizationProfile, upsertOrganization, toOrgRecord } from "../services/organizations";
import { importLegacyReference } from "./run";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];
const healthId = "11111111-1111-1111-1111-111111111111";
const ministryRow = {
  Id: healthId, Key: "health", SortOrder: 10, DisplayName: "Health", Abbreviation: "HLTH", IsActive: true,
  MinisterEmail: "SP.Minister@gov.bc.ca", MinisterPhotoUrl: null, MinisterPageHtml: "<p>bio</p>", MinisterAddress: "PO BOX 9050",
  MinisterName: "Honourable Sam Placeholder", MinisterSummary: "Honourable Sam Placeholder", MinistryUrl: "http://gov.bc.ca/health", ParentKey: null,
  WeekendContactNumber: "", DisplayAdditionalName: null, TwitterUsername: "", FlickrUrl: null, YoutubeUrl: null, AudioUrl: null,
  ContactUserId: null, ContactFullName: null, ContactPhone: null, ContactMobile: null, ContactEmail: null,
  SecondContactUserId: null, SecondContactFullName: null, SecondContactPhone: null, SecondContactMobile: null, SecondContactEmail: null,
};
const source = createFakeSource({
  ministries: [ministryRow],
  ministryTopics: [{ MinistryId: healthId, SortIndex: 0, LinkText: "Get immunized", LinkUrl: "https://x" }],
  ministryServices: [],
  ministrySectors: [{ MinistryId: healthId, SectorKey: "health" }],
  sectors: [{ Id: "22222222-2222-2222-2222-222222222222", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health", EnglishName: "Health", TwitterUsername: "", FlickrUrl: "", YoutubeUrl: "", AudioUrl: "" }],
  themes: [{ Id: "33333333-3333-3333-3333-333333333333", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health" }],
  tags: [],
  services: [],
  servicesPresent: [{ present: 1 }],
});

describe("importLegacyReference", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports organizations and terms and emits events", async () => {
    const result = await importLegacyReference(tdb.db, source, subs);
    expect(result).toEqual({ organizations: { total: 1, changed: 1, skippedStaffEdited: 0 }, terms: { total: 2, changed: 2 }, missingTables: [] });
    const [org] = await listOrganizations(tdb.db);
    expect(org!.topicLinks).toEqual([{ text: "Get immunized", url: "https://x" }]);
    expect(org!.sectorKeys).toEqual(["health"]);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(3);
  });

  it("second import emits no events", async () => {
    const result = await importLegacyReference(tdb.db, source, subs);
    expect(result).toEqual({ organizations: { total: 1, changed: 0, skippedStaffEdited: 0 }, terms: { total: 2, changed: 0 }, missingTables: [] });
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(3);
  });

  it("the importer skips a staff-edited organization", async () => {
    const other = await createCoreTestDb();
    try {
      await importLegacyReference(other.db, source, subs);
      await patchOrganizationProfile(other.db, "health", { displayName: "Health (staff)" }, subs);
      const result = await importLegacyReference(other.db, source, subs);
      expect(result.organizations).toEqual({ total: 1, changed: 0, skippedStaffEdited: 1 });
      expect((await listOrganizations(other.db))[0]!.displayName).toBe("Health (staff)");
    } finally {
      await other.drop();
    }
  });

  it("the importer leaves a deactivated organization inactive", async () => {
    const other = await createCoreTestDb();
    try {
      await importLegacyReference(other.db, source, subs);
      expect(await deactivateOrganization(other.db, "health", subs)).toBe(true);
      const result = await importLegacyReference(other.db, source, subs);
      expect(result.organizations).toEqual({ total: 1, changed: 0, skippedStaffEdited: 1 });
      expect((await listOrganizations(other.db))[0]!.isActive).toBe(false);
    } finally {
      await other.drop();
    }
  });

  it("skips dbo.Service when the legacy database doesn't have it, and still imports ministries", async () => {
    const other = await createCoreTestDb();
    try {
      const withoutServices = createFakeSource({
        ministries: [ministryRow], ministryTopics: [], ministryServices: [], ministrySectors: [],
        sectors: [], themes: [], tags: [], servicesPresent: [{ present: 0 }],
      });
      const result = await importLegacyReference(other.db, withoutServices, subs);
      expect(result).toEqual({ organizations: { total: 1, changed: 1, skippedStaffEdited: 0 }, terms: { total: 0, changed: 0 }, missingTables: ["dbo.Service"] });
      expect(await listOrganizations(other.db)).toHaveLength(1);
    } finally {
      await other.drop();
    }
  });
});

describe("importLegacyReference: hidden legacy HTML columns", () => {
  const extrasRow = {
    ...ministryRow,
    MiscHtml: "<script>alert(1)</script><p>misc</p>",
    MiscRightHtml: "<p>right</p>",
    FacebookEmbedHtml: "",
    YoutubeEmbedHtml: null,
    AudioEmbedHtml: "<audio></audio>",
  };
  const sectorId = "22222222-2222-2222-2222-222222222222";
  const sectorRow = { Id: sectorId, Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health", EnglishName: "Health", TwitterUsername: "", FlickrUrl: "", YoutubeUrl: "", AudioUrl: "", MiscHtml: "<p>sector misc</p>", MiscRightHtml: "", FacebookEmbedHtml: "", YoutubeEmbedHtml: "", AudioEmbedHtml: "" };
  const make = (ministry: Record<string, unknown>, sector: Record<string, unknown> = sectorRow) =>
    createFakeSource({ ministries: [ministry], ministryTopics: [], ministryServices: [], ministrySectors: [], sectors: [sector], themes: [], tags: [], services: [], servicesPresent: [{ present: 1 }] });
  const extrasOf = async (db: TestDatabase["db"]) => (await db.select().from(organizations).where(eq(organizations.key, "health")))[0]!.legacyExtras;

  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("stores the non-empty columns on the organization and the sector, as-is", async () => {
    await importLegacyReference(tdb.db, make(extrasRow), subs);
    expect(await extrasOf(tdb.db)).toEqual({ miscHtml: "<script>alert(1)</script><p>misc</p>", miscRightHtml: "<p>right</p>", audioEmbedHtml: "<audio></audio>" });
    const [sector] = await tdb.db.select().from(terms).where(eq(terms.kind, "sector"));
    expect(sector!.legacyExtras).toEqual({ miscHtml: "<p>sector misc</p>" });
  });

  it("leaves the extras null when every column is empty", async () => {
    const other = await createCoreTestDb();
    try {
      await importLegacyReference(other.db, make(ministryRow), subs);
      expect(await extrasOf(other.db)).toBeNull();
    } finally {
      await other.drop();
    }
  });

  it("the org event payload is the same shape with or without extras: no legacyExtras, no HTML", async () => {
    const events = await tdb.db.select().from(outboxEvents);
    const orgEvents = events.filter((e) => e.type === "org.upserted");
    expect(orgEvents).toHaveLength(1);
    const payload = JSON.stringify(orgEvents[0]);
    expect(payload).not.toMatch(/legacyExtras|legacy_extras|miscHtml|alert\(1\)/);
    const plain = await createCoreTestDb();
    try {
      await importLegacyReference(plain.db, make(ministryRow), subs);
      const plainEvent = (await plain.db.select().from(outboxEvents)).find((e) => e.type === "org.upserted")!;
      const keys = (e: typeof plainEvent) => Object.keys((e.envelope as { data: object }).data).sort();
      expect(keys(orgEvents[0]!)).toEqual(keys(plainEvent));
    } finally {
      await plain.drop();
    }
  });

  it("a re-import with unchanged columns emits nothing; changed columns update the stored value silently", async () => {
    const before = (await tdb.db.select().from(outboxEvents)).length;
    await importLegacyReference(tdb.db, make(extrasRow), subs);
    expect((await tdb.db.select().from(outboxEvents)).length).toBe(before);
    await importLegacyReference(tdb.db, make({ ...extrasRow, MiscHtml: "<p>new</p>", AudioEmbedHtml: "" }), subs);
    expect(await extrasOf(tdb.db)).toEqual({ miscHtml: "<p>new</p>", miscRightHtml: "<p>right</p>" });
    expect((await tdb.db.select().from(outboxEvents)).length).toBe(before);
  });

  it("a re-import whose columns became empty clears the stored value", async () => {
    await importLegacyReference(tdb.db, make(ministryRow), subs);
    expect(await extrasOf(tdb.db)).toBeNull();
    await importLegacyReference(tdb.db, make(extrasRow), subs);
  });

  it("a staff edit (an upsert that does not send the extras) keeps them; so does a Hub profile edit", async () => {
    const before = await extrasOf(tdb.db);
    expect(before).not.toBeNull();
    const [row] = await tdb.db.select().from(organizations).where(eq(organizations.key, "health"));
    const { updatedAt: _u, isHq: _h, isPublic: _p, successorKeys: _s, ...input } = toOrgRecord(row!);
    await upsertOrganization(tdb.db, { ...input, displayName: "Health (admin)" }, subs, { staffEdit: true });
    expect(await extrasOf(tdb.db)).toEqual(before);
    await patchOrganizationProfile(tdb.db, "health", { displayName: "Health (hub)" }, subs);
    expect(await extrasOf(tdb.db)).toEqual(before);
  });

  it("a staff-edited organization is still skipped for content, but its legacy extras refresh", async () => {
    const result = await importLegacyReference(tdb.db, make({ ...extrasRow, DisplayName: "Legacy name", MiscHtml: "<p>refreshed</p>" }), subs);
    expect(result.organizations.skippedStaffEdited).toBe(1);
    const [row] = await tdb.db.select().from(organizations).where(eq(organizations.key, "health"));
    expect(row!.displayName).toBe("Health (hub)");
    expect(row!.legacyExtras).toMatchObject({ miscHtml: "<p>refreshed</p>" });
  });
});
