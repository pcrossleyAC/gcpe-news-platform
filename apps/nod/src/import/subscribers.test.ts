import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, waitForLockWaiter } from "../../test/helpers";
import { FIXTURE_GUIDS as G, legacyNodSource, legacyNodTables, seedNodListsForImport } from "../../test/legacy-nod-fixture";
import { mediaOptOuts, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { lockAddress } from "../locks";
import { addMediaMember, OptedOutError, removeMediaMember } from "../media-members";
import { ALL_MEDIA_LISTS, keepMediaOptOuts, optOutHash } from "../opt-outs";
import { importLists, NodNotReadyError } from "./lists";
import { NodImportReport } from "./report";
import { deleteSubscriber } from "../staff-subscribers/actions";
import { importSubscribers } from "./subscribers";

const TZ = "America/Vancouver";
const RUN_AT = new Date("2026-11-20T18:00:00Z");
const id = (g: string) => g.toLowerCase();
const VICTORIA = "media-distribution-lists:000-0-victoria";
const SAMPLE_TOWN = "media-distribution-lists:sample-town";
const OPTED_OUT = "opted out of this media list in NoD (staff must confirm a re-add)";
const ENDED = "unsubscribed in legacy since the last import (NoD's record ended)";
const HOLDER_ENDED = "unsubscribed in legacy: NoD's record of the address ended";
const NEWER_IN_NOD = "unsubscribed in legacy before a newer subscribe in NoD (not applied)";

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
  const historyOf = async (sid: string) => (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, sid))).map((h) => [h.action, h.detail, h.actor]);
  /** What the retention purge does to one ended record. */
  const purge = async (sid: string) =>
    tdb.db.transaction(async (tx) => {
      await tx.update(subscribers).set({ status: "deleted", endedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(subscribers.id, sid));
      const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, sid));
      await keepMediaOptOuts(tx, s!);
      await tx.delete(subscribers).where(eq(subscribers.id, sid));
    });
  /** Resolves once at least `n` sessions are waiting for a lock. */
  const waitForLockWaiters = async (n: number) => {
    for (const deadline = Date.now() + 5000; ; ) {
      const r = await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (r.rows[0]!.n >= n) return;
      if (Date.now() > deadline) throw new Error(`fewer than ${n} sessions waiting for a lock`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  /** Holds `email`'s address lock until the returned release() is called; `then` runs just before it commits. */
  const holdAddress = async (email: string, then: (tx: Parameters<Parameters<typeof tdb.db.transaction>[0]>[0]) => Promise<void> = async () => {}) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const ready = new Promise<void>((r) => (held = r));
    const done = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, email);
      held();
      await gate;
      await then(tx);
    });
    await ready;
    return { release, done };
  };
  const listsOf = async (g: string) => (await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id(g)))).map((s) => s.listKey).sort();
  /** As though every record so far was imported at `at`. */
  const importedOn = (at: string) => tdb.db.execute(sql`UPDATE legacy_subscriber_imports SET imported_at = ${at}::timestamptz`);
  /** Legacy tables where `guid` unsubscribed (104) at BC wall-clock `wall`, ending its record. */
  const unsubscribedInLegacy = (guid: string, wall: string, tables = legacyNodTables()) => {
    tables.subscribers = tables.subscribers!.map((s) => (s.SubscriberGuid === guid ? { ...s, IsDeleted: true, IsEnabled: false } : s));
    tables.unsubscribed = [...tables.unsubscribed!, { SubscriberGuid: guid, UnsubscribedAt: new Date(`${wall}Z`) }];
    return tables;
  };
  const unsubscribedHistory = async (sid: string) =>
    (await tdb.db.select().from(subscriberHistory).where(and(eq(subscriberHistory.subscriberId, sid), eq(subscriberHistory.action, "unsubscribed")))).map((h) => [h.at.toISOString(), h.actor]);

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
    // Legacy ended it on 2026-05-01, but the purge's 90 days start no earlier than the import.
    expect(await subscriber(G.subDeleted)).toMatchObject({ status: "deleted", endedAt: RUN_AT });
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

  it("a media-list leave legacy records after NoD changed the record still takes them off that list", async () => {
    await run();
    await tdb.db.update(subscribers).set({ digest: true }).where(eq(subscribers.id, id(G.subMedia)));
    const tables = legacyNodTables();
    tables.subscriberLists = tables.subscriberLists!.filter((r) => !(r.SubscriberGuid === G.subMedia && r.ListGuid === G.listVictoria));
    tables.mediaListLeaves = [...tables.mediaListLeaves!.filter((r) => r.SubscriberGuid !== G.subMedia), { SubscriberGuid: G.subMedia, ListGuid: G.listVictoria, LeftAt: new Date("2026-09-01T09:00:00Z") }];
    const { report } = await run(tables);
    expect(await listsOf(G.subMedia)).toEqual([SAMPLE_TOWN]);
    expect(await subscriber(G.subMedia)).toMatchObject({ digest: true });
    expect(await historyOf(id(G.subMedia))).toContainEqual(["media-list-opted-out", VICTORIA, "Legacy import"]);
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: "changed in NoD since the last import (NoD's record kept)", sample: [id(G.subMedia)] }));
    await expect(addMediaMember(tdb.db, "000-0-victoria", { email: "journo@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("a staff re-add in NoD made after a legacy leave stays", async () => {
    await run();
    await removeMediaMember(tdb.db, "000-0-victoria", id(G.subMedia), "staff:jamie");
    await addMediaMember(tdb.db, "000-0-victoria", { email: "journo@example.test", source: "manual-media" }, "staff:jamie");
    await tdb.db.update(subscribers).set({ digest: true }).where(eq(subscribers.id, id(G.subMedia)));
    const tables = legacyNodTables();
    tables.subscriberLists = tables.subscriberLists!.filter((r) => !(r.SubscriberGuid === G.subMedia && r.ListGuid === G.listVictoria));
    tables.mediaListLeaves = [...tables.mediaListLeaves!.filter((r) => r.SubscriberGuid !== G.subMedia), { SubscriberGuid: G.subMedia, ListGuid: G.listVictoria, LeftAt: new Date("2026-09-01T09:00:00Z") }];
    await run(tables);
    expect(await listsOf(G.subMedia)).toEqual([VICTORIA, SAMPLE_TOWN]);
    expect((await historyOf(id(G.subMedia))).filter(([a]) => a === "media-list-opted-out")).toEqual([]);
  });

  /** journo left both media lists in legacy after NoD purged the imported record. */
  const leftAfterPurge = () => {
    const tables = legacyNodTables();
    tables.subscriberLists = tables.subscriberLists!.filter((r) => r.SubscriberGuid !== G.subMedia);
    tables.mediaListLeaves = [...tables.mediaListLeaves!, { SubscriberGuid: G.subMedia, ListGuid: G.listByName, LeftAt: new Date("2026-09-01T09:00:00Z") }];
    return tables;
  };

  it("legacy leaves for a record NoD purged are kept on NoD's new record of that address", async () => {
    await run();
    await purge(id(G.subMedia));
    const [nod] = await tdb.db.insert(subscribers).values({ email: "journo@example.test", status: "active", source: "self" }).returning({ id: subscribers.id });
    const { report } = await run(leftAfterPurge());
    expect(await subscriber(G.subMedia)).toBeUndefined();
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: "removed in NoD since the last import" }));
    const history = await historyOf(nod!.id);
    expect(history).toContainEqual(["media-list-opted-out", SAMPLE_TOWN, "Legacy import"]);
    expect(history).toContainEqual(["media-list-opted-out", VICTORIA, "Legacy import"]);
    await expect(addMediaMember(tdb.db, "sample-town", { email: "journo@example.test", source: "media-hub" }, "media-hub-sync")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("legacy leaves for a record NoD purged are kept as opt-out hashes when NoD has no record of that address", async () => {
    await run();
    await purge(id(G.subMedia));
    await run(leftAfterPurge());
    const kept = await tdb.db.select().from(mediaOptOuts).where(eq(mediaOptOuts.emailHash, optOutHash("journo@example.test")));
    expect(kept.map((k) => k.listKey).sort()).toEqual([VICTORIA, SAMPLE_TOWN]);
    expect(JSON.stringify(kept)).not.toContain("@");
    await expect(addMediaMember(tdb.db, "sample-town", { email: "journo@example.test", source: "media-hub" }, "media-hub-sync")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("a legacy unsubscribe becomes history at its own date, so a purged media member stays off every media list", async () => {
    const tables = legacyNodTables();
    tables.subscribers = tables.subscribers!.map((s) => (s.SubscriberGuid === G.subMedia ? { ...s, IsDeleted: true, IsEnabled: false } : s));
    tables.unsubscribed = [{ SubscriberGuid: G.subMedia, UnsubscribedAt: new Date("2026-05-01T10:00:00Z") }];
    tables.mediaListLeaves = tables.mediaListLeaves!.filter((r) => r.SubscriberGuid !== G.subMedia);
    await run(tables);
    const unsubscribed = await tdb.db.select().from(subscriberHistory).where(and(eq(subscriberHistory.subscriberId, id(G.subMedia)), eq(subscriberHistory.action, "unsubscribed")));
    expect(unsubscribed.map((h) => [h.at, h.actor])).toEqual([[new Date("2026-05-01T17:00:00Z"), "Legacy import"]]);
    expect(await subscriber(G.subMedia)).toMatchObject({ status: "deleted", endedAt: RUN_AT });
    // A staff delete (8) ends the record but isn't the subscriber's own unsubscribe.
    expect((await historyOf(id(G.subDeleted))).filter(([a]) => a === "unsubscribed")).toEqual([]);
    await run(tables);
    expect(await tdb.db.select().from(subscriberHistory).where(and(eq(subscriberHistory.subscriberId, id(G.subMedia)), eq(subscriberHistory.action, "unsubscribed")))).toHaveLength(1);

    await purge(id(G.subMedia));
    expect((await tdb.db.select().from(mediaOptOuts)).map((k) => k.listKey)).toEqual([ALL_MEDIA_LISTS]);
    await expect(addMediaMember(tdb.db, "000-0-victoria", { email: "journo@example.test", source: "media-hub" }, "media-hub-sync")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("a record whose address moves while the import waits for its lock is left for the next run", async () => {
    await run();
    const journey = await holdAddress("active@example.test", async (tx) => {
      await tx.update(subscribers).set({ email: "moved@example.test" }).where(eq(subscribers.id, id(G.subActive)));
    });
    const importing = run();
    await waitForLockWaiter(tdb.db);
    journey.release();
    await journey.done;
    const { report } = await importing;
    expect(await subscriber(G.subActive)).toMatchObject({ email: "moved@example.test" });
    expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: "changed while importing: run the import again", count: 1, sample: [id(G.subActive)] });
  });

  it("an update that a live journey overtakes after the batch commits keeps the journey's change", async () => {
    await run();
    const tables = legacyNodTables();
    tables.subscribers = tables.subscribers!.map((s) => (s.SubscriberGuid === G.subActive ? { ...s, ImmediateDelivery: false, DigestDelivery: true } : s));
    // Hold an address the batch locks after active@, so the journey can queue for active@ behind the batch.
    const blocker = await holdAddress("left@example.test");
    const importing = run(tables);
    await waitForLockWaiters(1);
    const journey = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, "active@example.test");
      await tx.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, id(G.subActive)));
    });
    await waitForLockWaiters(2);
    blocker.release();
    await blocker.done;
    await journey;
    const { report } = await importing;
    expect(await subscriber(G.subActive)).toMatchObject({ status: "disabled", asItHappens: true, digest: false });
    expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: "changed in NoD since the last import (NoD's record kept)", count: 1, sample: [id(G.subActive)] });
  });

  it("a legacy unsubscribe made since the last import ends a record NoD has changed, as a NoD unsubscribe would", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await tdb.db.update(subscribers).set({ digest: true }).where(eq(subscribers.id, id(G.subMedia)));
    const tables = unsubscribedInLegacy(G.subMedia, "2026-09-01T10:00:00");
    const { report } = await run(tables);
    const s = await subscriber(G.subMedia);
    expect(s).toMatchObject({ status: "deleted" });
    expect(s!.endedAt).not.toBeNull();
    expect(await listsOf(G.subMedia)).toEqual([]);
    expect(await unsubscribedHistory(id(G.subMedia))).toEqual([["2026-09-01T17:00:00.000Z", "Legacy import"]]);
    expect(await historyOf(id(G.subMedia))).toContainEqual(["media-list-opted-out", SAMPLE_TOWN, "Legacy import"]);
    expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: ENDED, count: 1, sample: [id(G.subMedia)] });
    await expect(addMediaMember(tdb.db, "sample-town", { email: "journo@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);

    const historyBefore = (await tdb.db.select().from(subscriberHistory)).length;
    await run(tables);
    expect((await tdb.db.select().from(subscriberHistory)).length).toBe(historyBefore);
  });

  it("a legacy unsubscribe ends a NoD-changed record only once: a later NoD re-add stands", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await tdb.db.update(subscribers).set({ digest: true }).where(eq(subscribers.id, id(G.subMedia)));
    const tables = unsubscribedInLegacy(G.subMedia, "2026-09-01T10:00:00");
    await run(tables);
    await addMediaMember(tdb.db, "sample-town", { email: "journo@example.test", source: "manual-media", confirmOptOut: true }, "staff:jamie");
    await run(tables);
    expect(await subscriber(G.subMedia)).toMatchObject({ status: "active" });
    expect(await listsOf(G.subMedia)).toEqual([SAMPLE_TOWN]);
  });

  it("a legacy unsubscribe already imported doesn't end a record NoD has changed since", async () => {
    await run(unsubscribedInLegacy(G.subMedia, "2026-07-01T10:00:00"));
    await importedOn("2026-08-01T00:00:00Z");
    await addMediaMember(tdb.db, "sample-town", { email: "journo@example.test", source: "manual-media", confirmOptOut: true }, "staff:jamie");
    const { report } = await run(unsubscribedInLegacy(G.subMedia, "2026-07-01T10:00:00"));
    expect(await subscriber(G.subMedia)).toMatchObject({ status: "active" });
    expect(await listsOf(G.subMedia)).toEqual([SAMPLE_TOWN]);
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: "changed in NoD since the last import (NoD's record kept)", sample: [id(G.subMedia)] }));
  });

  it("a legacy unsubscribe made since the last import ends the record when legacy moved it onto an address NoD holds", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    const [nod] = await tdb.db.insert(subscribers).values({ email: "elsewhere@example.test", status: "active", source: "self" }).returning({ id: subscribers.id });
    const tables = unsubscribedInLegacy(G.subMedia, "2026-09-01T10:00:00");
    tables.subscribers = tables.subscribers!.map((s) => (s.SubscriberGuid === G.subMedia ? { ...s, EmailAddress: "elsewhere@example.test" } : s));
    const { report } = await run(tables);
    expect(await subscriber(G.subMedia)).toMatchObject({ email: "journo@example.test", status: "deleted" });
    expect(await listsOf(G.subMedia)).toEqual([]);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, nod!.id)))[0]).toMatchObject({ status: "active" });
    expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: ENDED, count: 1, sample: [id(G.subMedia)] });
  });

  it("a legacy unsubscribe made since the last import of a record NoD purged is kept as an every-list hash", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await purge(id(G.subDigest));
    expect(await tdb.db.select().from(mediaOptOuts)).toEqual([]);
    const { report } = await run(unsubscribedInLegacy(G.subDigest, "2026-09-01T10:00:00"));
    expect(await subscriber(G.subDigest)).toBeUndefined();
    const kept = await tdb.db.select().from(mediaOptOuts).where(eq(mediaOptOuts.emailHash, optOutHash("digest@example.test")));
    expect(kept.map((k) => [k.listKey, k.optedOutAt.toISOString()])).toEqual([[ALL_MEDIA_LISTS, "2026-09-01T17:00:00.000Z"]]);
    expect(JSON.stringify(report.toJSON())).not.toContain("@");
    await expect(addMediaMember(tdb.db, "000-0-victoria", { email: "digest@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("staff delete, purge, then a legacy unsubscribe: re-adding the address asks first", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await deleteSubscriber(tdb.db, id(G.subActive), "staff:jamie");
    await purge(id(G.subActive));
    // Deleted in legacy too, the 2024 duplicate record now stands for the address.
    await run(unsubscribedInLegacy(G.subActive, "2026-09-01T10:00:00"));
    await expect(addMediaMember(tdb.db, "000-0-victoria", { email: "active@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("an unsubscribe on a duplicate legacy record counts for its address", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await purge(id(G.subActive));
    const tables = legacyNodTables();
    tables.unsubscribed = [{ SubscriberGuid: G.subDuplicate, UnsubscribedAt: new Date("2026-09-01T10:00:00Z") }];
    await run(tables);
    const kept = await tdb.db.select().from(mediaOptOuts).where(eq(mediaOptOuts.emailHash, optOutHash("active@example.test")));
    expect(kept.map((k) => k.listKey)).toEqual([ALL_MEDIA_LISTS]);
  });

  it("a legacy unsubscribe newer than NoD's own record of the address ends that record, as a NoD unsubscribe would", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await purge(id(G.subActive));
    const [nod] = await tdb.db.insert(subscribers).values({ email: "active@example.test", status: "active", source: "self", createdAt: new Date("2026-08-15T17:00:00Z") }).returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values({ subscriberId: nod!.id, listKey: VICTORIA });
    const { report } = await run(unsubscribedInLegacy(G.subActive, "2026-09-01T10:00:00"));
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, nod!.id)))[0]).toMatchObject({ status: "deleted" });
    expect(await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, nod!.id))).toEqual([]);
    expect(await unsubscribedHistory(nod!.id)).toEqual([["2026-09-01T17:00:00.000Z", "Legacy import"]]);
    expect(await historyOf(nod!.id)).toContainEqual(["media-list-opted-out", VICTORIA, "Legacy import"]);
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: HOLDER_ENDED }));
    await run(unsubscribedInLegacy(G.subActive, "2026-09-01T10:00:00"));
    expect(await unsubscribedHistory(nod!.id)).toHaveLength(1);
  });

  it("a legacy unsubscribe older than NoD's own record of the address leaves that record alone, and says so", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await purge(id(G.subActive));
    const [nod] = await tdb.db.insert(subscribers).values({ email: "active@example.test", status: "active", source: "self", createdAt: new Date("2026-09-15T17:00:00Z") }).returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values({ subscriberId: nod!.id, listKey: VICTORIA });
    const { report } = await run(unsubscribedInLegacy(G.subActive, "2026-09-01T10:00:00"));
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, nod!.id)))[0]).toMatchObject({ status: "active" });
    expect((await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, nod!.id))).map((r) => r.listKey)).toEqual([VICTORIA]);
    expect(await unsubscribedHistory(nod!.id)).toEqual([]);
    expect(report.toJSON().skipped).toContainEqual(expect.objectContaining({ table: "Subscriber", reason: NEWER_IN_NOD }));
  });

  for (const action of ["subscribed", "resubscribed", "staff-activated"] as const) {
    it(`a NoD-changed record whose own "${action}" is newer than the legacy unsubscribe stays, with its lists`, async () => {
      await run();
      await importedOn("2026-08-01T00:00:00Z");
      await tdb.db.update(subscribers).set({ digest: true }).where(eq(subscribers.id, id(G.subMedia)));
      await tdb.db.insert(subscriberHistory).values({ subscriberId: id(G.subMedia), actor: "subscriber", action, at: new Date("2026-09-02T17:00:00Z") });
      const { report } = await run(unsubscribedInLegacy(G.subMedia, "2026-09-01T10:00:00"));
      expect(await subscriber(G.subMedia)).toMatchObject({ status: "active" });
      expect(await listsOf(G.subMedia)).toEqual([VICTORIA, SAMPLE_TOWN]);
      expect(await unsubscribedHistory(id(G.subMedia))).toEqual([]);
      expect(report.toJSON().skipped).toContainEqual({ table: "Subscriber", reason: NEWER_IN_NOD, count: 1, sample: [id(G.subMedia)] });
    });
  }

  it("a NoD resubscribe at the same moment as the legacy unsubscribe doesn't stop it ending the record", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await tdb.db.update(subscribers).set({ digest: true }).where(eq(subscribers.id, id(G.subMedia)));
    await tdb.db.insert(subscriberHistory).values({ subscriberId: id(G.subMedia), actor: "subscriber", action: "resubscribed", at: new Date("2026-09-01T17:00:00Z") });
    await run(unsubscribedInLegacy(G.subMedia, "2026-09-01T10:00:00"));
    expect(await subscriber(G.subMedia)).toMatchObject({ status: "deleted" });
  });

  it("legacy moving a record onto an address with a kept opt-out takes it off those media lists", async () => {
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("optedout@example.test"), listKey: ALL_MEDIA_LISTS, optedOutAt: new Date("2026-06-01T17:00:00Z") });
    await run();
    await addMediaMember(tdb.db, "sample-town", { email: "journo@example.test", source: "manual-media" }, "staff:jamie");
    const tables = legacyNodTables();
    tables.subscribers = tables.subscribers!.map((s) => (s.SubscriberGuid === G.subMedia ? { ...s, EmailAddress: "optedout@example.test" } : s));
    const { report } = await run(tables);
    expect(await subscriber(G.subMedia)).toMatchObject({ email: "optedout@example.test" });
    expect(await listsOf(G.subMedia)).toEqual([]);
    expect(report.toJSON().skipped).toContainEqual({
      table: "SubscriberList",
      reason: OPTED_OUT,
      count: 2,
      sample: [`${id(G.subMedia)}/${id(G.listVictoria)}`, `${id(G.subMedia)}/${id(G.listByName)}`],
    });
    expect(JSON.stringify(report.toJSON())).not.toContain("@");
    expect((await historyOf(id(G.subMedia))).filter(([a]) => a === "media-list-added")).toHaveLength(1);
    // The add made at the old address doesn't count at the new one.
    await expect(addMediaMember(tdb.db, "sample-town", { email: "optedout@example.test", source: "manual-media" }, "staff:jamie")).rejects.toBeInstanceOf(OptedOutError);
  });

  it("a staff remove and re-add in NoD outlasts an older legacy leave, though the record looks untouched", async () => {
    await run();
    await importedOn("2026-08-01T00:00:00Z");
    await removeMediaMember(tdb.db, "000-0-victoria", id(G.subMedia), "staff:jamie");
    await addMediaMember(tdb.db, "000-0-victoria", { email: "journo@example.test", source: "manual-media" }, "staff:jamie");
    await tdb.db.execute(sql`UPDATE subscriber_history SET at = '2026-08-15T17:00:00Z' WHERE subscriber_id = ${id(G.subMedia)}::uuid AND action IN ('media-list-removed', 'media-list-added')`);
    const leftOn = (wall: string) => {
      const tables = legacyNodTables();
      tables.subscriberLists = tables.subscriberLists!.filter((r) => !(r.SubscriberGuid === G.subMedia && r.ListGuid === G.listVictoria));
      tables.mediaListLeaves = [...tables.mediaListLeaves!.filter((r) => r.SubscriberGuid !== G.subMedia), { SubscriberGuid: G.subMedia, ListGuid: G.listVictoria, LeftAt: new Date(`${wall}Z`) }];
      return tables;
    };
    await run(leftOn("2026-08-10T09:00:00"));
    expect(await listsOf(G.subMedia)).toEqual([VICTORIA, SAMPLE_TOWN]);
    expect((await historyOf(id(G.subMedia))).filter(([a]) => a === "media-list-opted-out")).toEqual([]);

    await run(leftOn("2026-08-20T09:00:00"));
    expect(await listsOf(G.subMedia)).toEqual([SAMPLE_TOWN]);
    expect(await historyOf(id(G.subMedia))).toContainEqual(["media-list-opted-out", VICTORIA, "Legacy import"]);
  });
});
