import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, createScheduledRelease, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { ReleaseRuleError, ReleaseStateError } from "../releases/errors";
import { createRelease, deleteRelease } from "../releases/service";
import { loadView } from "../releases/store";
import { publishDue } from "../publisher";
import { unpublish } from "../releases/workflow";
import { clearFeaturesFor, featuredWhere, setFeature } from "./features";

const subs: SubscriberConfig[] = [];

describe("website/features — Top and Feature slots", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query(
      "TRUNCATE news_releases, category_features, release_log, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE",
    );
  });

  const siteEvents = async () =>
    (await tdb.pool.query("SELECT type, aggregate_id, envelope FROM outbox_events WHERE type = 'site.content.changed' ORDER BY created_at, sequence"))
      .rows as { type: string; aggregate_id: string; envelope: { data: Record<string, unknown> } }[];

  const publish = async (over: Record<string, unknown> = {}) => {
    const scheduled = await createScheduledRelease(tdb.db, over);
    const r = await publishDue({ db: tdb.db, subscribers: subs });
    if (!r.published.includes(scheduled.key!)) throw new Error(`expected ${scheduled.key} to publish; got ${JSON.stringify(r)}`);
    return (await loadView(tdb.db, scheduled.id))!;
  };

  it("setFeature on a draft release is refused with ReleaseStateError", async () => {
    await seedTaxonomy(tdb.db);
    const draft = await createRelease(tdb.db, sampleCreate, editor);
    await expect(setFeature(tdb.db, draft.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs)).rejects.toThrow(ReleaseStateError);
  });

  it("a takeover moves the previous release out: A's view loses the slot, B's view gains it, two home events with the latest topPostKey", async () => {
    const a = await publish({ headline: "Release A headline" });
    const b = await publish({ headline: "Release B headline" });

    const afterA = await setFeature(tdb.db, a.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs);
    expect(afterA.features).toEqual([{ kind: "home", key: "default", slot: "top" }]);

    const afterB = await setFeature(tdb.db, b.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs);
    expect(afterB.features).toEqual([{ kind: "home", key: "default", slot: "top" }]);

    const aNow = (await loadView(tdb.db, a.id))!;
    expect(aNow.features).toEqual([]);

    const events = await siteEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.envelope.data).toMatchObject({ entity: "home", topPostKey: a.key });
    expect(events[1]!.envelope.data).toMatchObject({ entity: "home", topPostKey: b.key });
  });

  // Minor 4: category_features itself carries no timestamp, so a Top/Feature change for home
  // must move site_settings.updated_at (the field homeSnapshot's "timestamp" reads) — otherwise
  // a home snapshot with a new topPostKey/featurePostKey can carry a stale, unchanged timestamp.
  it("Minor 4: a Top/Feature change for home bumps site_settings.updated_at", async () => {
    const a = await publish({ headline: "Timestamp release A" });
    const before = (await tdb.pool.query("SELECT updated_at FROM site_settings WHERE id = 1")).rows[0]!.updated_at as Date;

    await setFeature(tdb.db, a.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs);

    const after = (await tdb.pool.query("SELECT updated_at FROM site_settings WHERE id = 1")).rows[0]!.updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    const events = await siteEvents();
    expect(events).toHaveLength(1);
    expect(new Date((events[0]!.envelope.data as { timestamp: string }).timestamp).getTime()).toBe(after.getTime());
  });

  it("Feature for ministries/health on a release not tagged health is refused with ReleaseRuleError", async () => {
    const notHealth = await publish({ ministries: ["finance"], leadMinistryKey: "finance", sectors: ["education"] });
    await expect(
      setFeature(tdb.db, notHealth.id, { kind: "ministries", key: "health", slot: "feature", on: true }, editor, subs),
    ).rejects.toThrow(ReleaseRuleError);
  });

  it("Feature for ministries/health emits one categoryFeatures event with featurePostKey set", async () => {
    const release = await publish();
    const view = await setFeature(tdb.db, release.id, { kind: "ministries", key: "health", slot: "feature", on: true }, editor, subs);
    expect(view.features).toEqual([{ kind: "ministries", key: "health", slot: "feature" }]);

    const events = await siteEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_id).toBe("site:feature:ministries:health");
    expect(events[0]!.envelope.data).toMatchObject({ entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: null, featurePostKey: release.key });
  });

  it("writes the release log and the site log (area features)", async () => {
    const release = await publish();
    await setFeature(tdb.db, release.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs);
    const releaseLogRows = (await tdb.pool.query("SELECT text FROM release_log WHERE release_id = $1 ORDER BY id DESC LIMIT 1", [release.id])).rows;
    expect(releaseLogRows[0].text).toBe("Set as Top for Home");
    const siteLogRows = (await tdb.pool.query("SELECT area, text FROM site_log ORDER BY id DESC LIMIT 1")).rows;
    expect(siteLogRows[0]).toMatchObject({ area: "features", text: "Set as Top for Home" });

    await setFeature(tdb.db, release.id, { kind: "home", key: "default", slot: "top", on: false }, editor, subs);
    const releaseLogRows2 = (await tdb.pool.query("SELECT text FROM release_log WHERE release_id = $1 ORDER BY id DESC LIMIT 1", [release.id])).rows;
    expect(releaseLogRows2[0].text).toBe("Removed as Top for Home");
  });

  it("unpublishing a release holding Top for Home and Feature for sectors/health clears both slots and emits two site events in the unpublish transaction", async () => {
    const release = await publish();
    await setFeature(tdb.db, release.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs);
    await setFeature(tdb.db, release.id, { kind: "sectors", key: "health", slot: "feature", on: true }, editor, subs);

    await unpublish(tdb.db, release.id, (await loadView(tdb.db, release.id))!.version, editor);
    const r = await publishDue({ db: tdb.db, subscribers: subs });
    expect(r.unpublished).toEqual([release.key]);

    const after = (await loadView(tdb.db, release.id))!;
    expect(after.features).toEqual([]);

    const events = await siteEvents();
    // Two from setFeature above, two more from the unpublish clearing both slots.
    expect(events).toHaveLength(4);
    const last2 = events.slice(-2).map((e) => e.aggregate_id).sort();
    expect(last2).toEqual(["site:feature:sectors:health", "site:home"]);
    const homeEvent = events.find((e, i) => i >= 2 && e.aggregate_id === "site:home")!;
    expect(homeEvent.envelope.data).toMatchObject({ topPostKey: null });
    const sectorEvent = events.find((e, i) => i >= 2 && e.aggregate_id === "site:feature:sectors:health")!;
    expect(sectorEvent.envelope.data).toMatchObject({ featurePostKey: null });
  });

  it("deleting a release holding a slot clears it", async () => {
    const release = await publish();
    await setFeature(tdb.db, release.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs);
    await unpublish(tdb.db, release.id, (await loadView(tdb.db, release.id))!.version, editor);
    await publishDue({ db: tdb.db, subscribers: subs });
    // Simulate a dangling slot (e.g. legacy data) still pointing at a now-unpublished, deletable release.
    await tdb.pool.query("UPDATE category_features SET top_release_id = $1 WHERE kind = 'home' AND key = 'default'", [release.id]);

    const unpublished = (await loadView(tdb.db, release.id))!;
    const outcome = await deleteRelease(tdb.db, release.id, unpublished.version, editor, undefined, subs);
    expect(outcome).toBe(unpublished.reference ? "hidden" : "deleted");

    const [row] = (await tdb.pool.query("SELECT top_release_id FROM category_features WHERE kind = 'home' AND key = 'default'")).rows;
    expect(row.top_release_id).toBeNull();
  });

  it("clearFeaturesFor is a no-op (no event) when the release holds nothing", async () => {
    const release = await publish();
    await tdb.db.transaction((tx) => clearFeaturesFor(tx, release.id, subs));
    expect(await siteEvents()).toEqual([]);
  });

  it("two concurrent setFeature takeovers for a never-used category both fulfil — no raw unique-violation — and exactly one ends up holding the slot", async () => {
    const a = await publish({ headline: "Concurrent A" });
    const b = await publish({ headline: "Concurrent B" });

    const results = await Promise.allSettled([
      setFeature(tdb.db, a.id, { kind: "sectors", key: "health", slot: "top", on: true }, editor, subs),
      setFeature(tdb.db, b.id, { kind: "sectors", key: "health", slot: "top", on: true }, editor, subs),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const rows = (await tdb.pool.query("SELECT top_release_id FROM category_features WHERE kind = 'sectors' AND key = 'health'")).rows;
    expect(rows).toHaveLength(1);
    expect([a.id, b.id]).toContain(rows[0].top_release_id);
    const winner = rows[0].top_release_id === a.id ? a : b;
    const loser = winner === a ? b : a;

    expect((await loadView(tdb.db, winner.id))!.features).toEqual([{ kind: "sectors", key: "health", slot: "top" }]);
    expect((await loadView(tdb.db, loser.id))!.features).toEqual([]);
  });

  it("on:false on a slot that was never set is a no-op: no row is created, and featuredWhere skips it", async () => {
    const release = await publish();
    const view = await setFeature(tdb.db, release.id, { kind: "sectors", key: "health", slot: "top", on: false }, editor, subs);
    expect(view.features).toEqual([]);
    const rows = (await tdb.pool.query("SELECT 1 FROM category_features WHERE kind = 'sectors' AND key = 'health'")).rows;
    expect(rows).toHaveLength(0);
    expect(await featuredWhere(tdb.db)).toEqual([]);
    expect(await siteEvents()).toEqual([]);
  });

  it("setFeature rejects kind 'home' with a key other than 'default'", async () => {
    const release = await publish();
    await expect(
      setFeature(tdb.db, release.id, { kind: "home", key: "not-default", slot: "top", on: true }, editor, subs),
    ).rejects.toThrow(ReleaseRuleError);
    expect(await featuredWhere(tdb.db)).toEqual([]);
  });

  it("featuredWhere lists home first, with headlines, labelled by kind", async () => {
    const home = await publish({ headline: "Home headline" });
    const health = await publish({ headline: "Health headline" });
    await setFeature(tdb.db, home.id, { kind: "home", key: "default", slot: "top", on: true }, editor, subs);
    await setFeature(tdb.db, health.id, { kind: "ministries", key: "health", slot: "feature", on: true }, editor, subs);

    const rows = await featuredWhere(tdb.db);
    expect(rows[0]).toMatchObject({ kind: "home", key: "default", label: "Home", top: { id: home.id, key: home.key, headline: "Home headline" }, feature: null });
    const healthRow = rows.find((r) => r.kind === "ministries" && r.key === "health")!;
    expect(healthRow).toMatchObject({ label: "Health", top: null, feature: { id: health.id, key: health.key, headline: "Health headline" } });
  });
});
