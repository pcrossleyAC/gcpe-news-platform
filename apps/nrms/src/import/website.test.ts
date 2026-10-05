import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createFakeSource, type LegacySource } from "@gcpe/legacy-import";
import { createNrmsTestDb, editor } from "../../test/helpers";
import { carousels, emergencyPins, siteLog, siteSettings, websiteResourceLinks, websiteSlides } from "../db/schema";
import { saveLinks } from "../website/links";
import { ImportReport } from "./report";
import { importWebsite } from "./website";

const subs: SubscriberConfig[] = [];
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");

interface FakeTables {
  appSettings?: Record<string, unknown>[];
  carousels?: Record<string, unknown>[];
  carouselSlides?: Record<string, unknown>[];
  resourceLinks?: Record<string, unknown>[];
}

function source(tables: FakeTables): LegacySource {
  return createFakeSource({
    appSettings: tables.appSettings ?? [],
    carousels: tables.carousels ?? [],
    carouselSlides: tables.carouselSlides ?? [],
    resourceLinks: tables.resourceLinks ?? [],
  });
}

describe("importWebsite", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE carousels, slides, resource_links, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    await tdb.pool.query(
      "UPDATE site_settings SET live_feed_enabled=false, live_manifest_url='', live_m3u_url='', granville=NULL, links_version=1, version=1, website_imported_at=NULL, website_imported_version=NULL, updated_at=now() WHERE id=1",
    );
    await tdb.pool.query(
      "UPDATE emergency_pins SET pinned=false, headline='', summary='', action_url='', facebook_post_url='', justify='left', image=NULL, image_type=NULL, version=1, updated_at=now()",
    );
  });

  const outboxCount = async (): Promise<number> => {
    const r = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events");
    return r.rows[0].n as number;
  };

  it("assigns live/next/past states and copies slides in SortIndex order with image types sniffed", async () => {
    const now = Date.now();
    const src = source({
      carousels: [
        { Id: "c-live", PublishDateTime: new Date(now - 1 * DAY), Timestamp: new Date(now) },
        { Id: "c-past-1", PublishDateTime: new Date(now - 2 * DAY), Timestamp: new Date(now) },
        { Id: "c-past-2", PublishDateTime: new Date(now - 3 * DAY), Timestamp: new Date(now) },
        { Id: "c-past-3", PublishDateTime: new Date(now - 4 * DAY), Timestamp: new Date(now) },
        { Id: "c-next", PublishDateTime: new Date(now + 1 * DAY), Timestamp: new Date(now) },
      ],
      carouselSlides: [
        { CarouselId: "c-live", SlideId: "s1", SortIndex: 1, Headline: "Second", Summary: "", ActionUrl: "", Image: JPEG, FacebookPostUrl: null, Justify: 1, Timestamp: new Date() },
        { CarouselId: "c-live", SlideId: "s0", SortIndex: 0, Headline: "First", Summary: "", ActionUrl: "", Image: PNG, FacebookPostUrl: null, Justify: 0, Timestamp: new Date() },
      ],
    });
    const report = new ImportReport();
    const result = await importWebsite(tdb.db, src, report, { force: false });
    expect(result).toEqual({ skipped: false });

    const rows = await tdb.db.select().from(carousels);
    const live = rows.find((r) => r.state === "live");
    const next = rows.find((r) => r.state === "next");
    const past = rows.filter((r) => r.state === "past");
    expect(live).toBeTruthy();
    expect(next).toBeTruthy();
    expect(past).toHaveLength(3);

    const liveSlides = (await tdb.db.select().from(websiteSlides).where(eq(websiteSlides.carouselId, live!.id))).sort((a, b) => a.sortIndex - b.sortIndex);
    expect(liveSlides.map((s) => s.headline)).toEqual(["First", "Second"]);
    expect(liveSlides[0]!.imageType).toBe("image/png");
    expect(liveSlides[0]!.justify).toBe("left");
    expect(liveSlides[1]!.imageType).toBe("image/jpeg");
    expect(liveSlides[1]!.justify).toBe("right");

    const json = report.toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables.carousels).toEqual({ legacy: 5, imported: 5, skipped: 0 });
    expect(json.tables.slides).toEqual({ legacy: 2, imported: 2, skipped: 0 });
  });

  it("keeps only the five newest remaining past carousels; older ones are skipped with a reason", async () => {
    const now = Date.now();
    const rows = Array.from({ length: 8 }, (_, i) => ({ Id: `c${i}`, PublishDateTime: new Date(now - (i + 1) * DAY), Timestamp: new Date(now) }));
    const report = new ImportReport();
    const result = await importWebsite(tdb.db, source({ carousels: rows }), report, { force: false });
    expect(result).toEqual({ skipped: false });

    const stored = await tdb.db.select().from(carousels);
    expect(stored.filter((r) => r.state === "live")).toHaveLength(1);
    expect(stored.filter((r) => r.state === "past")).toHaveLength(5);

    const json = report.toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables.carousels).toEqual({ legacy: 8, imported: 6, skipped: 2 });
    const reasons = json.skipped.filter((s) => s.table === "carousels").map((s) => s.reason);
    expect(reasons).toEqual(["more than five past carousels", "more than five past carousels"]);
  });

  it("pins the primary slide from its legacy slide content (SortIndex < 0); leaves secondary unpinned", async () => {
    const src = source({
      appSettings: [
        { SettingName: "IsPinnedSlide", SettingValue: "true" },
        { SettingName: "PinnedSlideId", SettingValue: "PIN-S1" },
        { SettingName: "PinnedCarouselId", SettingValue: "PIN-C1" },
        { SettingName: "IsPinnedSecondarySlide", SettingValue: "false" },
      ],
      carousels: [{ Id: "pin-c1", PublishDateTime: new Date(Date.now() - 60_000), Timestamp: new Date() }],
      carouselSlides: [
        { CarouselId: "PIN-C1", SlideId: "pin-s1", SortIndex: -1, Headline: "Emergency!", Summary: "Flooding", ActionUrl: "https://x", Image: PNG, FacebookPostUrl: null, Justify: 1, Timestamp: new Date() },
      ],
    });
    const report = new ImportReport();
    const result = await importWebsite(tdb.db, src, report, { force: false });
    expect(result).toEqual({ skipped: false });

    const pins = await tdb.db.select().from(emergencyPins);
    const primary = pins.find((p) => p.slot === "primary")!;
    const secondary = pins.find((p) => p.slot === "secondary")!;
    expect(primary.pinned).toBe(true);
    expect(primary.headline).toBe("Emergency!");
    expect(primary.summary).toBe("Flooding");
    expect(primary.actionUrl).toBe("https://x");
    expect(primary.imageType).toBe("image/png");
    expect(primary.justify).toBe("right");
    expect(secondary.pinned).toBe(false);

    // The pinned slide (SortIndex < 0) never becomes a carousel slide.
    const liveRow = (await tdb.db.select().from(carousels))[0]!;
    const liveSlides = await tdb.db.select().from(websiteSlides).where(eq(websiteSlides.carouselId, liveRow.id));
    expect(liveSlides).toHaveLength(0);

    const json = report.toJSON();
    expect(json.tables.slides).toEqual({ legacy: 1, imported: 0, skipped: 1 });
    expect(json.skipped.find((s) => s.table === "slides")?.reason).toBe("pinned slide (SortIndex < 0), not a carousel slide");
  });

  it("turns the Live Feed on with empty URLs; granville 'false' normalises to null", async () => {
    const src = source({
      appSettings: [
        { SettingName: "live_webcast_enabled", SettingValue: "true" },
        { SettingName: "granville", SettingValue: "false" },
      ],
    });
    const report = new ImportReport();
    await importWebsite(tdb.db, src, report, { force: false });
    const [settings] = await tdb.db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    expect(settings!.liveFeedEnabled).toBe(true);
    expect(settings!.liveManifestUrl).toBe("");
    expect(settings!.liveM3uUrl).toBe("");
    expect(settings!.granville).toBeNull();
  });

  it("granville 'TRUE' (any case) normalises to the stored 'true', and logs it as a system entry only when ON", async () => {
    const report = new ImportReport();
    await importWebsite(tdb.db, source({ appSettings: [{ SettingName: "granville", SettingValue: "TRUE" }] }), report, { force: false });
    const [settings] = await tdb.db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    expect(settings!.granville).toBe("true");
    const logs = await tdb.db.select().from(siteLog).where(eq(siteLog.area, "blue-bridge"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.text).toBe("Imported Project Blue Bridge as ON");
    expect(logs[0]!.actorId).toBe("system");
  });

  it("imports resource links in sort-index order with fresh ids", async () => {
    const src = source({
      resourceLinks: [
        { SortIndex: 2, LinkText: "C", LinkUrl: "/c" },
        { SortIndex: 0, LinkText: "A", LinkUrl: "/a" },
        { SortIndex: 1, LinkText: "B", LinkUrl: "/b" },
      ],
    });
    const report = new ImportReport();
    await importWebsite(tdb.db, src, report, { force: false });
    const rows = (await tdb.db.select().from(websiteResourceLinks)).sort((a, b) => a.sortIndex - b.sortIndex);
    expect(rows.map((r) => r.text)).toEqual(["A", "B", "C"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);

    const json = report.toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables.resource_links).toEqual({ legacy: 3, imported: 3, skipped: 0 });
  });

  it("writes no outbox rows; an unchanged re-run doesn't bump versions; an edit since import is skipped unless forced", async () => {
    const src = source({
      appSettings: [{ SettingName: "granville", SettingValue: "true" }],
      resourceLinks: [{ SortIndex: 0, LinkText: "A", LinkUrl: "/a" }],
    });

    const before1 = await outboxCount();
    const first = await importWebsite(tdb.db, src, new ImportReport(), { force: false });
    expect(first).toEqual({ skipped: false });
    expect(await outboxCount()).toBe(before1);

    const [afterFirst] = await tdb.db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    const [primaryAfterFirst] = await tdb.db.select().from(emergencyPins).where(eq(emergencyPins.slot, "primary"));
    expect(afterFirst!.websiteImportedVersion).toBe(afterFirst!.version);

    // Re-running against the same, unchanged legacy data must not bump site_settings.version,
    // an emergency pin's own version, or write a second "Imported Project Blue Bridge as ON" line.
    const before2 = await outboxCount();
    const second = await importWebsite(tdb.db, src, new ImportReport(), { force: false });
    expect(second).toEqual({ skipped: false });
    expect(await outboxCount()).toBe(before2);

    const [afterSecond] = await tdb.db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    expect(afterSecond!.version).toBe(afterFirst!.version);
    expect(afterSecond!.granville).toBe(afterFirst!.granville);
    const [primaryAfterSecond] = await tdb.db.select().from(emergencyPins).where(eq(emergencyPins.slot, "primary"));
    expect(primaryAfterSecond!.version).toBe(primaryAfterFirst!.version);
    const bbLogs = await tdb.db.select().from(siteLog).where(eq(siteLog.area, "blue-bridge"));
    expect(bbLogs).toHaveLength(1);
    const linksAfterSecond = await tdb.db.select().from(websiteResourceLinks);
    expect(linksAfterSecond.map((r) => r.text)).toEqual(["A"]);

    // A real edit in NRMS (saveLinks) writes a non-system site_log entry after website_imported_at.
    await saveLinks(tdb.db, { version: 1, links: [{ text: "Edited", url: "https://edited.invalid" }] }, editor, subs);

    const third = await importWebsite(tdb.db, src, new ImportReport(), { force: false });
    expect(third).toEqual({ skipped: true, reason: "website edited in NRMS since the last import" });
    const linksAfterSkip = await tdb.db.select().from(websiteResourceLinks);
    expect(linksAfterSkip.map((r) => r.text)).toEqual(["Edited"]);

    // force: true overrides the edited-since-import check and reimports from legacy anyway.
    const fourth = await importWebsite(tdb.db, src, new ImportReport(), { force: true });
    expect(fourth).toEqual({ skipped: false });
    const linksAfterForce = await tdb.db.select().from(websiteResourceLinks);
    expect(linksAfterForce.map((r) => r.text)).toEqual(["A"]);
  });
});
