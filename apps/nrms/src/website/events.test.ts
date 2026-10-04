import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, siteContentChangedSchema, type SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, createScheduledRelease, editor } from "../../test/helpers";
import { carousels, categoryFeatures, emergencyPins, siteLog, siteSettings, websiteSlides as slides } from "../db/schema";
import { emitSite, homeSnapshot, slidesSnapshot, writeSiteLog } from "./events";

const subscribers: SubscriberConfig[] = [];

describe("website/events", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query(
      "TRUNCATE news_releases, category_features, carousels, slides, emergency_pins, resource_links, site_files, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE",
    );
    await tdb.pool.query("UPDATE site_settings SET live_feed_enabled = false, live_manifest_url = '', live_m3u_url = '', granville = NULL WHERE id = 1");
  });

  it("a fresh database has exactly one site_settings row; homeSnapshot is all null", async () => {
    const rows = await tdb.db.select().from(siteSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);

    const snap = await tdb.db.transaction((tx) => homeSnapshot(tx));
    expect(snap).toMatchObject({
      entity: "home",
      topPostKey: null,
      featurePostKey: null,
      liveWebcastFlashMediaManifestUrl: null,
      liveWebcastM3uPlaylist: null,
      granville: null,
    });
  });

  it("carries live-feed URLs only while the live feed is enabled, even though they stay stored when disabled", async () => {
    await tdb.db
      .update(siteSettings)
      .set({ liveFeedEnabled: true, liveManifestUrl: "https://live.example/manifest.f4m", liveM3uUrl: "https://live.example/playlist.m3u8" })
      .where(eq(siteSettings.id, 1));
    const enabled = await tdb.db.transaction((tx) => homeSnapshot(tx));
    expect(enabled.liveWebcastFlashMediaManifestUrl).toBe("https://live.example/manifest.f4m");
    expect(enabled.liveWebcastM3uPlaylist).toBe("https://live.example/playlist.m3u8");

    await tdb.db.update(siteSettings).set({ liveFeedEnabled: false }).where(eq(siteSettings.id, 1));
    const disabled = await tdb.db.transaction((tx) => homeSnapshot(tx));
    expect(disabled.liveWebcastFlashMediaManifestUrl).toBeNull();
    expect(disabled.liveWebcastM3uPlaylist).toBeNull();

    const [row] = await tdb.db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    expect(row!.liveManifestUrl).toBe("https://live.example/manifest.f4m"); // still stored
  });

  it("homeSnapshot resolves category_features('home','default') release ids to release keys", async () => {
    const top = await createScheduledRelease(tdb.db);
    const feature = await createScheduledRelease(tdb.db, { headline: "Second release, different headline" });
    await tdb.db.insert(categoryFeatures).values({ kind: "home", key: "default", topReleaseId: top.id, featureReleaseId: feature.id });

    const snap = await tdb.db.transaction((tx) => homeSnapshot(tx));
    expect(snap.topPostKey).toBe(top.key);
    expect(snap.featurePostKey).toBe(feature.key);
  });

  it("orders pinned slides before the live carousel's, skips an unpinned pin, and renders justify in legacy case", async () => {
    await tdb.db.insert(emergencyPins).values({ slot: "primary", pinned: true, headline: "Primary pin", justify: "left" });
    // secondary stays absent/unpinned.

    const [carousel] = await tdb.db.insert(carousels).values({ state: "live" }).returning();
    await tdb.db.insert(slides).values([
      { carouselId: carousel!.id, sortIndex: 5, headline: "First", justify: "left" },
      { carouselId: carousel!.id, sortIndex: 9, headline: "Second", justify: "right" },
    ]);

    const snap = await tdb.db.transaction((tx) => slidesSnapshot(tx));
    expect(snap.entity).toBe("slides");
    expect(snap.slides.map((s) => [s.sortIndex, s.headline, s.justify])).toEqual([
      [-2, "Primary pin", "Left"],
      [0, "First", "Left"],
      [1, "Second", "Right"],
    ]);
  });

  it("slidesSnapshot returns only the pinned slides when there is no live carousel", async () => {
    await tdb.db.insert(emergencyPins).values([
      { slot: "primary", pinned: true, headline: "Primary pin" },
      { slot: "secondary", pinned: true, headline: "Secondary pin" },
    ]);

    const snap = await tdb.db.transaction((tx) => slidesSnapshot(tx));
    expect(snap.slides.map((s) => [s.sortIndex, s.headline])).toEqual([
      [-2, "Primary pin"],
      [-1, "Secondary pin"],
    ]);
  });

  it("emitSite('slides') enqueues one outbox event of type site.content.changed that round-trips through the catalogue schema", async () => {
    await tdb.db.transaction((tx) => emitSite(tx, subscribers, "slides"));
    const rows = await tdb.db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "site.content.changed", aggregateId: "site:slides" });
    const envelope = rows[0]!.envelope as { data: unknown };
    const parsed = siteContentChangedSchema.parse(envelope.data);
    expect(parsed.entity).toBe("slides");
  });

  it("the database refuses a second live carousel and a next carousel without a go-live time", async () => {
    await tdb.db.insert(carousels).values({ state: "live" });
    await expect(tdb.db.insert(carousels).values({ state: "live" })).rejects.toThrow();
    await expect(tdb.db.insert(carousels).values({ state: "next" })).rejects.toThrow();
    await expect(tdb.db.insert(carousels).values({ state: "next", goLiveAt: new Date() })).resolves.not.toThrow();
  });

  it("writeSiteLog records the actor, area and text", async () => {
    await tdb.db.transaction((tx) => writeSiteLog(tx, editor, "carousel", "Published the next carousel"));
    const [row] = await tdb.db.select().from(siteLog);
    expect(row).toMatchObject({ actorId: editor.id, actorName: editor.name, area: "carousel", text: "Published the next carousel" });
  });
});
