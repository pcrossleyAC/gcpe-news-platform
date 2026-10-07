import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, waitForLockWaiter } from "../../test/helpers";
import { FIXTURE_GUIDS as G, legacyNodSource, legacyNodTables, seedNodListsForImport } from "../../test/legacy-nod-fixture";
import { mediaOptOuts, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { lockAddress } from "../locks";
import { addMediaMember, OptedOutError } from "../media-members";
import { ALL_MEDIA_LISTS, optOutHash } from "../opt-outs";
import { importLists, NodNotReadyError } from "./lists";
import { NodImportReport } from "./report";
import { importSubscribers } from "./subscribers";

const TZ = "America/Vancouver";
const RUN_AT = new Date("2026-11-20T18:00:00Z");
const id = (g: string) => g.toLowerCase();
const VICTORIA = "media-distribution-lists:000-0-victoria";
const SAMPLE_TOWN = "media-distribution-lists:sample-town";
const OPTED_OUT = "opted out of this media list in NoD (staff must confirm a re-add)";

describe("importing legacy subscribers", () => {
  let tdb: TestDatabase;
  async function run(tables = legacyNodTables()) {
    const report = new NodImportReport();
    const source = legacyNodSource(tables);
    const lists = await importLists(tdb.db, source, report);
    const imported = await importSubscribers(tdb.db, source, { report, timeZone: TZ, lists, runAt: RUN_AT });
    return { report, imported };
  }
  const subscriber = async (g: string) => (await tdb.db.select().from(subscribers).where(eq(subscribers.id, id(g))))[0];
  const listsOf = async (g: string) => (await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id(g)))).map((s) => s.listKey).sort();

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM subscriber_history; DELETE FROM subscriptions; DELETE FROM subscribers; DELETE FROM legacy_subscriber_imports; DELETE FROM media_opt_outs; DELETE FROM lists WHERE category IN ('ministries', 'media-distribution-lists');`);
    await seedNodListsForImport(tdb.db);
  });

  it("refuses to start before Core's lists have reached NoD", async () => {
    await tdb.db.execute(sql`DELETE FROM lists WHERE category = 'ministries'`);
    await expect(importLists(tdb.db, legacyNodSource(), new NodImportReport())).rejects.toBeInstanceOf(NodNotReadyError);
  });

  it("maps statuses, timing, sources, addresses and dates", async () => {
    await run();
    expect(await subscriber(G.subActive)).toMatchObject({ email: "active@example.test", status: "active", asItHappens: true, digest: false, source: "self", createdAt: new Date("2017-03-01T17:00:00Z"), verifiedAt: new Date("2017-03-01T17:00:00Z"), endedAt: null });
    expect(await subscriber(G.subDigest)).toMatchObject({ status: "active", asItHappens: false, digest: true });
    expect(await subscriber(G.subDeleted)).toMatchObject({ status: "deleted", endedAt: new Date("2026-05-01T17:00:00Z") });
    expect(await subscriber(G.subDisabled)).toMatchObject({ status: "disabled" });
    expect(await subscriber(G.subMedia)).toMatchObject({ email: "journo@example.test", source: "manual-media", mediaHubContactId: null });
    expect(await subscriber(G.subNoTiming)).toMatchObject({ status: "active", asItHappens: false, digest: false });
    expect(await subscriber(G.subDuplicate)).toBeUndefined();
    expect(await subscriber(G.subInvalid)).toBeUndefined();
  });

  it("memberships: carried lists only, '*' for All news, none for a deleted subscriber", async () => {
    await run();
    expect(await listsOf(G.subActive)).toEqual(["*", "ministries:health"]);
    expect(await listsOf(G.subMedia)).toEqual(["media-distribution-lists:000-0-victoria", "media-distribution-lists:sample-town"]);
    expect(await listsOf(G.subDeleted)).toEqual([]);
    expect(await listsOf(G.subDisabled)).toEqual(["ministries:health"]);
  });

  it("a legacy media-list leave becomes opt-out history, and staff are asked before re-adding", async () => {
    await run();
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id(G.subLeftMedia)));
    expect(history.map((h) => [h.action, h.detail, h.actor])).toContainEqual(["media-list-opted-out", "media-distribution-lists:000-0-victoria", "Legacy import"]);
    await expect(addMediaMember(tdb.db, "000-0-victoria", { email: "left@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
    const journo = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id(G.subMedia)));
    expect(journo.some((h) => h.action === "media-list-opted-out")).toBe(false);
  });

  it("the report balances, groups skips by reason and holds no address", async () => {
    const { report, imported } = await run();
    const json = report.toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables).toMatchObject({
      List: { legacy: 8, imported: 4, skipped: 4 },
      Subscriber: { legacy: 9, imported: 7, skipped: 2 },
      SubscriberList: { legacy: 13, imported: 8, skipped: 5 },
    });
    expect(json.skipped.map((s) => [s.table, s.reason, s.count])).toEqual(
      expect.arrayContaining([
        ["Subscriber", "duplicate address: another legacy record with it was imported", 1],
        ["Subscriber", "invalid email address", 1],
        ["SubscriberList", "subscriber not imported", 2],
        ["SubscriberList", "subscriber deleted in legacy: memberships not kept", 1],
      ]),
    );
    expect(JSON.stringify(json)).not.toContain("@");
    expect(imported.get(id(G.subMedia))?.mediaKeys).toEqual(new Set(["media-distribution-lists:000-0-victoria", "media-distribution-lists:sample-town"]));
  });

  it("re-run: unchanged records stay put and nothing is duplicated", async () => {
    await run();
    const historyBefore = (await tdb.db.select().from(subscriberHistory)).length;
    const { report } = await run();
    expect((await tdb.db.select().from(subscriberHistory)).length).toBe(historyBefore);
    expect(report.toJSON()).toMatchObject({ balanced: true, tables: { Subscriber: { imported: 7, skipped: 2 } } });
  });

  it("re-run: a change made in NoD wins; an untouched record picks up legacy's change", async () => {
    await run();
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, id(G.subDigest)));
    const tables = legacyNodTables();
    tables.subscribers = tables.subscribers!.map((s) =>
      s.SubscriberGuid === G.subActive ? { ...s, ImmediateDelivery: false, DigestDelivery: true } : s.SubscriberGuid === G.subDigest ? { ...s, DigestDelivery: false, ImmediateDelivery: true } : s,
    );
    const { report } = await run(tables);
    expect(await subscriber(G.subDigest)).toMatchObject({ status: "disabled", digest: true });
    expect(await subscriber(G.subActive)).toMatchObject({ asItHappens: false, digest: true });
    expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: "changed in NoD since the last import (NoD's record kept)", count: 1, sample: [id(G.subDigest)] });
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id(G.subActive)));
    expect(history.filter((h) => h.action === "legacy-imported").map((h) => h.detail).sort()).toEqual(["status active", "updated from legacy: status active"]);
  });

  it("an address a NoD subscriber already has is left to NoD", async () => {
    await tdb.db.insert(subscribers).values({ email: "notiming@example.test", status: "active", source: "self" });
    const { report } = await run();
    expect(await subscriber(G.subNoTiming)).toBeUndefined();
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: "address already in NoD (NoD's record kept)" }));
  });

  it("a record removed in NoD (purged) isn't brought back by a re-run", async () => {
    await run();
    await tdb.db.delete(subscribers).where(eq(subscribers.id, id(G.subDeleted)));
    const { report } = await run();
    expect(await subscriber(G.subDeleted)).toBeUndefined();
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: "removed in NoD since the last import" }));
  });

  it("an opt-out kept from a purged record keeps a legacy member off that media list", async () => {
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("journo@example.test"), listKey: VICTORIA, optedOutAt: new Date("2026-06-01T17:00:00Z") });
    const { report, imported } = await run();
    expect(await listsOf(G.subMedia)).toEqual([SAMPLE_TOWN]);
    const json = report.toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables.SubscriberList).toMatchObject({ legacy: 13, imported: 7, skipped: 6 });
    expect(json.skipped).toContainEqual({ table: "SubscriberList", reason: OPTED_OUT, count: 1, sample: [`${id(G.subMedia)}/${id(G.listVictoria)}`] });
    expect(JSON.stringify(json)).not.toContain("@");
    expect(imported.get(id(G.subMedia))?.mediaKeys).toEqual(new Set([VICTORIA, SAMPLE_TOWN]));

    const historyBefore = (await tdb.db.select().from(subscriberHistory)).length;
    const again = (await run()).report.toJSON();
    expect(again.skipped).toContainEqual(expect.objectContaining({ table: "SubscriberList", reason: OPTED_OUT, count: 1 }));
    expect(again.skipped.filter((s) => s.table === "Subscriber").map((s) => s.reason).sort()).toEqual([
      "duplicate address: another legacy record with it was imported",
      "invalid email address",
    ]);
    expect((await tdb.db.select().from(subscriberHistory)).length).toBe(historyBefore);
  });

  it("a kept every-list opt-out keeps a legacy member off every media list", async () => {
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("journo@example.test"), listKey: ALL_MEDIA_LISTS, optedOutAt: new Date("2026-06-01T17:00:00Z") });
    const { report } = await run();
    expect(await listsOf(G.subMedia)).toEqual([]);
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "SubscriberList", reason: OPTED_OUT, count: 2 }));
    expect(report.toJSON().balanced).toBe(true);
  });

  it("re-run: legacy putting someone back on a media list they opted out of in NoD doesn't re-add them", async () => {
    await run();
    const tables = legacyNodTables();
    tables.subscriberLists = [...tables.subscriberLists!, { SubscriberGuid: G.subLeftMedia, ListGuid: G.listVictoria }];
    const historyBefore = (await tdb.db.select().from(subscriberHistory)).length;
    const { report } = await run(tables);
    expect(await listsOf(G.subLeftMedia)).toEqual(["ministries:health"]);
    expect(report.toJSON().skipped).toContainEqual({ table: "SubscriberList", reason: OPTED_OUT, count: 1, sample: [`${id(G.subLeftMedia)}/${id(G.listVictoria)}`] });
    expect(report.toJSON().balanced).toBe(true);
    expect((await tdb.db.select().from(subscriberHistory)).length).toBe(historyBefore);
  });

  it("a duplicate legacy record's media-list leave is kept on the record imported for that address", async () => {
    const tables = legacyNodTables();
    tables.mediaListLeaves = [...tables.mediaListLeaves!, { SubscriberGuid: G.subDuplicate, ListGuid: G.listByName, LeftAt: new Date("2025-06-01T09:00:00Z") }];
    await run(tables);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id(G.subActive)));
    expect(history.map((h) => [h.action, h.detail, h.actor])).toContainEqual(["media-list-opted-out", SAMPLE_TOWN, "Legacy import"]);
    await expect(addMediaMember(tdb.db, "sample-town", { email: "active@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("a legacy media-list leave is kept on NoD's own record when the address is already in NoD", async () => {
    const [nod] = await tdb.db.insert(subscribers).values({ email: "left@example.test", status: "active", source: "self" }).returning({ id: subscribers.id });
    await run();
    expect(await subscriber(G.subLeftMedia)).toBeUndefined();
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, nod!.id));
    expect(history.map((h) => [h.action, h.detail, h.actor])).toEqual([["media-list-opted-out", VICTORIA, "Legacy import"]]);
    await run();
    expect(await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, nod!.id))).toHaveLength(1);
    await expect(addMediaMember(tdb.db, "000-0-victoria", { email: "left@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("waits for a live journey holding the address, and then keeps the change it made", async () => {
    await run();
    const tables = legacyNodTables();
    tables.subscribers = tables.subscribers!.map((s) => (s.SubscriberGuid === G.subActive ? { ...s, ImmediateDelivery: false, DigestDelivery: true } : s));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const ready = new Promise<void>((r) => (held = r));
    const journey = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, "active@example.test");
      held();
      await gate;
      await tx.update(subscribers).set({ status: "deleted" }).where(eq(subscribers.id, id(G.subActive)));
    });
    await ready;
    const importing = run(tables);
    await waitForLockWaiter(tdb.db);
    release();
    await journey;
    const { report } = await importing;
    expect(await subscriber(G.subActive)).toMatchObject({ status: "deleted", asItHappens: true, digest: false });
    expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: "changed in NoD since the last import (NoD's record kept)", count: 1, sample: [id(G.subActive)] });
  });
});
