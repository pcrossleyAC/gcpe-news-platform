import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { upsertOrganization } from "./organizations";
import { republishAll } from "./republish";
import { deactivateTerm, getTerm, listTerms, upsertTerm, type TermInput } from "./terms";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];
const economy: TermInput = {
  kind: "sector",
  key: "economy",
  displayName: "Economy",
  sortOrder: 0,
  isActive: true,
  social: { twitterUsername: "@BCGovNews", flickrUrl: null, youtubeUrl: null, audioUrl: null },
};

describe("terms service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE organizations, terms, outbox_events, aggregate_sequences CASCADE");
  });

  it("upserts with change detection and kind-specific event types", async () => {
    expect((await upsertTerm(tdb.db, economy, subs)).changed).toBe(true);
    expect((await upsertTerm(tdb.db, economy, subs)).changed).toBe(false);
    await upsertTerm(tdb.db, { ...economy, kind: "theme", key: "economy" }, subs);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => `${e.type}|${e.aggregateId}`);
    expect(types.sort()).toEqual(["sector.upserted|sector:economy", "theme.upserted|theme:economy"]);
    expect((await listTerms(tdb.db, "sector")).map((t) => t.key)).toEqual(["economy"]);
  });

  it("deactivates a term", async () => {
    await upsertTerm(tdb.db, economy, subs);
    expect(await deactivateTerm(tdb.db, "sector", "economy", subs)).toBe(true);
    expect((await getTerm(tdb.db, "sector", "economy"))!.isActive).toBe(false);
  });

  it("deactivating an already-inactive term is idempotent", async () => {
    await upsertTerm(tdb.db, economy, subs);
    expect(await deactivateTerm(tdb.db, "sector", "economy", subs)).toBe(true);
    expect(await deactivateTerm(tdb.db, "sector", "economy", subs)).toBe(true);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type);
    expect(types).toEqual(["sector.upserted", "sector.deactivated"]);
  });

  it("sets legacyId on an unchanged later call without emitting a second event", async () => {
    const legacyId = "33333333-3333-3333-3333-333333333333";
    await upsertTerm(tdb.db, economy, subs);
    const second = await upsertTerm(tdb.db, economy, subs, { legacyId });
    expect(second.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM terms WHERE kind = 'sector' AND key = 'economy'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("preserves legacyId when a later unchanged call omits it", async () => {
    const legacyId = "44444444-4444-4444-4444-444444444444";
    await upsertTerm(tdb.db, economy, subs, { legacyId });
    const second = await upsertTerm(tdb.db, economy, subs);
    expect(second.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    const { rows } = await tdb.pool.query("SELECT legacy_id FROM terms WHERE kind = 'sector' AND key = 'economy'");
    expect(rows[0].legacy_id).toBe(legacyId);
  });

  it("republishAll emits one upserted event per org and term", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    await upsertTerm(tdb.db, economy, subs);
    await tdb.pool.query("DELETE FROM outbox_events");
    expect(await republishAll(tdb.db, subs)).toBe(2);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type).sort();
    expect(types).toEqual(["org.upserted", "sector.upserted"]);
  });
});
