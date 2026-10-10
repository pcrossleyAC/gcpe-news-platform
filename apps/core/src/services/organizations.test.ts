import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import {
  HQ_ABBREVIATIONS,
  deactivateOrganization,
  getOrganization,
  isHqAbbreviation,
  isNonPublicAbbreviation,
  listOrganizations,
  setOrganizationHq,
  setOrganizationPublic,
  upsertOrganization,
} from "./organizations";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];

describe("organizations service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE organizations, outbox_events, aggregate_sequences CASCADE");
  });

  it("inserts, returns the record, and emits org.upserted", async () => {
    const { record, changed } = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(changed).toBe(true);
    expect(record).toMatchObject(healthOrg);
    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:health"));
    expect(events.map((e) => e.type)).toEqual(["org.upserted"]);
    expect((events[0]!.envelope as { data: unknown }).data).toEqual(record);
  });

  it("does not emit when nothing changed", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(again.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
  });

  it("emits again when a field changes", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, displayName: "Health and Wellness" }, subs);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(2);
    expect((await getOrganization(tdb.db, "health"))!.displayName).toBe("Health and Wellness");
  });

  it("deactivates and emits org.deactivated; unknown key returns false", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect(await deactivateOrganization(tdb.db, "health", subs)).toBe(true);
    expect((await getOrganization(tdb.db, "health"))!.isActive).toBe(false);
    expect(await deactivateOrganization(tdb.db, "nope", subs)).toBe(false);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.deactivated"]);
  });

  it("lists by sort order then key", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "b", sortOrder: 1 }, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "a", sortOrder: 2 }, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "c", sortOrder: 1 }, subs);
    expect((await listOrganizations(tdb.db)).map((o) => o.key)).toEqual(["b", "c", "a"]);
  });

  it("concurrent upserts of a brand-new key emit exactly once and preserve legacyId", async () => {
    const legacyId = "11111111-1111-1111-1111-111111111111";
    await Promise.all([
      upsertOrganization(tdb.db, { ...healthOrg, key: "concurrent" }, subs, { legacyId }),
      upsertOrganization(tdb.db, { ...healthOrg, key: "concurrent" }, subs),
    ]);
    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:concurrent"));
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM organizations WHERE key = 'concurrent'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("deactivating an already-inactive org is idempotent", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect(await deactivateOrganization(tdb.db, "health", subs)).toBe(true);
    expect(await deactivateOrganization(tdb.db, "health", subs)).toBe(true);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.deactivated"]);
  });

  it("sets legacyId on an unchanged later call without emitting a second event", async () => {
    const legacyId = "11111111-1111-1111-1111-111111111111";
    await upsertOrganization(tdb.db, healthOrg, subs);
    const second = await upsertOrganization(tdb.db, healthOrg, subs, { legacyId });
    expect(second.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM organizations WHERE key = 'health'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("preserves legacyId when a later unchanged call omits it", async () => {
    const legacyId = "22222222-2222-2222-2222-222222222222";
    await upsertOrganization(tdb.db, healthOrg, subs, { legacyId });
    const second = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(second.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM organizations WHERE key = 'health'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("an organization is not HQ until set; org.upserted carries the flag", async () => {
    const { record } = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(record.isHq).toBe(false);
    const hq = await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", abbreviation: "GCPEHQ", isHq: true }, subs);
    expect(hq.record.isHq).toBe(true);
    const [event] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:gcpe-headquarters"));
    expect((event!.envelope as { data: { isHq: boolean } }).data.isHq).toBe(true);
  });

  it("an upsert that omits isHq keeps the stored flag and emits nothing new", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, isHq: true }, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(again.changed).toBe(false);
    expect(again.record.isHq).toBe(true);
    const renamed = await upsertOrganization(tdb.db, { ...healthOrg, displayName: "Health and Wellness" }, subs);
    expect(renamed.record.isHq).toBe(true);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(2);
  });

  it("isHqOnCreate sets the flag only when the upsert creates the organization; an explicit isHq still wins (C124)", async () => {
    expect((await upsertOrganization(tdb.db, healthOrg, subs, { isHqOnCreate: true })).record.isHq).toBe(true);
    await setOrganizationHq(tdb.db, "health", false, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs, { isHqOnCreate: true });
    expect(again).toMatchObject({ changed: false, record: { isHq: false } });
    expect((await upsertOrganization(tdb.db, { ...healthOrg, isHq: true }, subs, { isHqOnCreate: false })).record.isHq).toBe(true);
  });

  it("setOrganizationHq flips the flag and emits once; the same value emits nothing; an unknown key is null", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect((await setOrganizationHq(tdb.db, "health", true, subs))!.isHq).toBe(true);
    expect((await setOrganizationHq(tdb.db, "health", true, subs))!.isHq).toBe(true);
    expect((await setOrganizationHq(tdb.db, "health", false, subs))!.isHq).toBe(false);
    const types = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:health"))).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.upserted", "org.upserted"]);
    expect(await setOrganizationHq(tdb.db, "no-such-org", true, subs)).toBeNull();
  });

  it("HQ abbreviations are GCPEHQ, GCPEMEDIA and PREM, matched trimmed and in any case (Q49)", () => {
    expect([...HQ_ABBREVIATIONS]).toEqual(["GCPEHQ", "GCPEMEDIA", "PREM"]);
    expect(isHqAbbreviation(" gcpemedia ")).toBe(true);
    expect(isHqAbbreviation("GCPEHQ")).toBe(true);
    expect(isHqAbbreviation("prem")).toBe(true);
    expect(isHqAbbreviation("HLTH")).toBe(false);
    expect(isHqAbbreviation("PREMX")).toBe(false);
    expect(isHqAbbreviation(null)).toBe(false);
  });

  describe("isPublic (Q54)", () => {
    it("a new organization is public unless told otherwise; isPublicOnCreate applies only on create", async () => {
      const created = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-a" }, []);
      expect(created.record.isPublic).toBe(true);
      const gcpe = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-b", abbreviation: "GCPEHQ" }, [], { isPublicOnCreate: false });
      expect(gcpe.record.isPublic).toBe(false);
      // An existing organization keeps its flag whatever isPublicOnCreate says.
      await setOrganizationPublic(tdb.db, "pub-b", true, []);
      const again = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-b", abbreviation: "GCPEHQ", displayName: "Renamed" }, [], { isPublicOnCreate: false });
      expect(again.record.isPublic).toBe(true);
    });

    it("an upsert that omits isPublic keeps the stored flag; one that sends it sets it", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c" }, []);
      await setOrganizationPublic(tdb.db, "pub-c", false, []);
      expect((await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c", displayName: "Renamed" }, [])).record.isPublic).toBe(false);
      expect((await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c", isPublic: true }, [])).record.isPublic).toBe(true);
    });

    it("setOrganizationPublic emits org.upserted only on a change, and 404s an unknown key", async () => {
      await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-d" }, []);
      const subs: SubscriberConfig[] = [{ name: "x", url: "http://x/events", secret: "s", types: ["org.upserted"] }];
      const before = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"))).length;
      expect((await setOrganizationPublic(tdb.db, "pub-d", true, subs))!.isPublic).toBe(true);
      expect((await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"))).length).toBe(before);
      expect((await setOrganizationPublic(tdb.db, "pub-d", false, subs))!.isPublic).toBe(false);
      const after = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"));
      expect(after.length).toBe(before + 1);
      expect((after.at(-1)!.envelope as { data: OrgRecord }).data.isPublic).toBe(false);
      expect(await setOrganizationPublic(tdb.db, "no-such-org", false, subs)).toBeNull();
    });

    it("isNonPublicAbbreviation matches GCPEHQ and GCPEMEDIA, trimmed and case-insensitive, and not PREM", () => {
      expect(isNonPublicAbbreviation(" gcpehq ")).toBe(true);
      expect(isNonPublicAbbreviation("GCPEMEDIA")).toBe(true);
      expect(isNonPublicAbbreviation("PREM")).toBe(false);
      expect(isNonPublicAbbreviation(null)).toBe(false);
    });
  });
});
