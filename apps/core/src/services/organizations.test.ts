import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { deactivateOrganization, getOrganization, listOrganizations, upsertOrganization } from "./organizations";

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
});
