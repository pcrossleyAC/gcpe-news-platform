import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbClock, type TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, editor } from "../../test/helpers";
import {
  createNextCarousel,
  deleteNextCarousel,
  getCarousels,
  getPins,
  makeNextLive,
  pinImage,
  saveCarousel,
  savePin,
  setPinImage,
  setPinned,
  setSlideImage,
  slideImage,
  switchCarousels,
  type SlideInput,
} from "./carousel";
import { SiteConflictError, SiteNotFoundError } from "./errors";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];
const TZ = "America/Vancouver";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
const HTML = Buffer.from("<html></html>");

const slide = (headline: string, over: Partial<SlideInput> = {}): SlideInput => ({
  headline,
  summary: "",
  actionUrl: "",
  facebookPostUrl: "",
  justify: "left",
  ...over,
});

describe("home-page carousel", () => {
  let tdb: TestDatabase;
  let t: Date;
  const now = () => t;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE carousels, slides, emergency_pins, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    // emergency_pins is seeded by migration 0012; TRUNCATE empties it, so re-seed here the same way.
    await tdb.pool.query("INSERT INTO emergency_pins (slot) VALUES ('primary'), ('secondary')");
    t = await dbClock(tdb.db);
  });

  const future = (ms = 60_000) => new Date(t.getTime() + ms).toISOString();

  const slidesEventCount = async () => {
    const r = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'site.content.changed'");
    return r.rows[0].n as number;
  };
  const lastSlidesEvent = async () => {
    const r = await tdb.pool.query(
      "SELECT envelope FROM outbox_events WHERE type = 'site.content.changed' ORDER BY created_at DESC, sequence DESC LIMIT 1",
    );
    return r.rows[0]?.envelope as { data: { entity: string; slides?: { headline: string | null; imageBase64: string | null }[] } } | undefined;
  };
  const lastLog = async () => {
    const r = await tdb.pool.query("SELECT actor_name, area, text FROM site_log ORDER BY id DESC LIMIT 1");
    return r.rows[0] as { actor_name: string; area: string; text: string } | undefined;
  };

  /** Creates a next carousel with `slides`, then promotes it to live. Returns its id. */
  const seedLiveCarousel = async (slides: SlideInput[]): Promise<string> => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    await saveCarousel(tdb.db, next.id, { version: next.version, slides }, editor, subs);
    await makeNextLive(tdb.db, editor, subs);
    return next.id;
  };

  it("1. createNextCarousel copies the live slides (new ids) and refuses a second next carousel", async () => {
    await seedLiveCarousel([slide("H1")]);
    const { live } = await getCarousels(tdb.db);
    expect(live!.slides).toHaveLength(1);
    const liveSlideId = live!.slides[0]!.id;

    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    expect(next.slides).toHaveLength(1);
    expect(next.slides[0]!.headline).toBe("H1");
    expect(next.slides[0]!.id).not.toBe(liveSlideId);

    await expect(createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ)).rejects.toThrow(SiteConflictError);
  });

  it("createNextCarousel refuses a go-live time that isn't in the future", async () => {
    await expect(createNextCarousel(tdb.db, { goLiveAt: new Date(t.getTime() - 60_000).toISOString() }, editor, subs, TZ)).rejects.toThrow(/future/i);
  });

  it("createNextCarousel logs the go-live time in BC time", async () => {
    await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    const log = await lastLog();
    expect(log!.text).toMatch(/^Created the next carousel for .+ at .+[ap]\.m\.$/);
    expect(log!.area).toBe("carousel");
  });

  it("fix round 1: saving the next carousel with a past goLiveAt → SiteRuleError and nothing changes", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    const past = new Date(t.getTime() - 60_000).toISOString();
    await expect(
      saveCarousel(tdb.db, next.id, { version: next.version, goLiveAt: past, slides: [slide("A")] }, editor, subs),
    ).rejects.toThrow(/future/i);
    const { next: reloaded } = await getCarousels(tdb.db);
    expect(reloaded!.version).toBe(next.version);
    expect(reloaded!.goLiveAt).toBe(next.goLiveAt);
    expect(reloaded!.slides).toHaveLength(0);
  });

  it("2. saveCarousel with a stale version → SiteConflictError; nothing changed", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("A")] }, editor, subs);
    await expect(saveCarousel(tdb.db, next.id, { version: next.version, slides: [] }, editor, subs)).rejects.toThrow(SiteConflictError);
    const { next: reloaded } = await getCarousels(tdb.db);
    expect(reloaded!.slides).toHaveLength(1);
    expect(reloaded!.slides[0]!.headline).toBe("A");
  });

  it("3. saving the live carousel emits one site.content.changed 'slides' event; saving the next carousel emits none", async () => {
    await seedLiveCarousel([]);
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);

    const beforeNext = await slidesEventCount();
    await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("N1")] }, editor, subs);
    expect(await slidesEventCount()).toBe(beforeNext);

    const { live } = await getCarousels(tdb.db);
    const beforeLive = await slidesEventCount();
    await saveCarousel(tdb.db, live!.id, { version: live!.version, slides: [slide("L1")] }, editor, subs);
    expect(await slidesEventCount()).toBe(beforeLive + 1);
    const ev = await lastSlidesEvent();
    expect(ev!.data.entity).toBe("slides");
  });

  it("4. switchCarousels before go_live_at does nothing; after it, live→past, next→live, one slides event, logged by System", async () => {
    await seedLiveCarousel([slide("Live1")]);
    const goLiveAt = new Date(t.getTime() + 60_000);
    const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);

    expect(await switchCarousels(tdb.db, subs, { now })).toEqual({ switched: false });

    const before = await slidesEventCount();
    t = new Date(goLiveAt.getTime() + 1000);
    expect(await switchCarousels(tdb.db, subs, { now })).toEqual({ switched: true });
    expect(await slidesEventCount()).toBe(before + 1);

    const { live, next: afterNext, past } = await getCarousels(tdb.db);
    expect(live!.id).toBe(next.id);
    expect(afterNext).toBeNull();
    expect(past).toHaveLength(1);
    expect(past[0]!.slides[0]!.headline).toBe("Live1");

    const log = await lastLog();
    expect(log).toMatchObject({ actor_name: "System", area: "carousel", text: "The next carousel went live" });
  });

  it("5. after seven switch-overs exactly five past carousels remain and their slides are deleted with them", async () => {
    await seedLiveCarousel([slide("Seed")]);
    for (let i = 0; i < 7; i++) {
      const goLiveAt = new Date(t.getTime() + 1000);
      const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
      await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide(`N${i}`)] }, editor, subs);
      t = new Date(goLiveAt.getTime() + 1000);
      expect(await switchCarousels(tdb.db, subs, { now })).toEqual({ switched: true });
    }
    const { past } = await getCarousels(tdb.db);
    expect(past).toHaveLength(5);
    // One slide per surviving carousel: the 5 kept past carousels plus the current live one
    // (the two oldest — the seed and the first switch-over — were deleted along with their slide).
    const rows = await tdb.pool.query("SELECT count(*)::int AS n FROM slides");
    expect(rows.rows[0].n).toBe(6);
  });

  it("6. two concurrent switchCarousels calls switch once", async () => {
    await seedLiveCarousel([]);
    const goLiveAt = new Date(t.getTime() + 1000);
    await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
    t = new Date(goLiveAt.getTime() + 1000);
    const results = await Promise.all([switchCarousels(tdb.db, subs, { now }), switchCarousels(tdb.db, subs, { now })]);
    expect(results.filter((r) => r.switched)).toHaveLength(1);
    expect(results.filter((r) => !r.switched)).toHaveLength(1);
  });

  it("7. pinned primary + secondary survive a switch-over and appear at -2/-1 in the emitted slides (C21)", async () => {
    await savePin(tdb.db, "primary", { version: 1, ...slide("P1") }, editor, subs);
    await setPinned(tdb.db, "primary", { version: 2, pinned: true }, editor, subs);
    await savePin(tdb.db, "secondary", { version: 1, ...slide("S1") }, editor, subs);
    await setPinned(tdb.db, "secondary", { version: 2, pinned: true }, editor, subs);

    await seedLiveCarousel([slide("Live1")]);
    const goLiveAt = new Date(t.getTime() + 1000);
    const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
    await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("Next1")] }, editor, subs);
    t = new Date(goLiveAt.getTime() + 1000);
    await switchCarousels(tdb.db, subs, { now });

    const ev = await lastSlidesEvent();
    expect(ev!.data.slides!.map((s) => s.headline)).toEqual(["P1", "S1", "Next1"]);
  });

  it("8. setPinned true without a headline → SiteRuleError; with one → slides event includes the pin", async () => {
    await expect(setPinned(tdb.db, "primary", { version: 1, pinned: true }, editor, subs)).rejects.toThrow(/headline/i);
    await savePin(tdb.db, "primary", { version: 1, ...slide("Alert") }, editor, subs);
    const before = await slidesEventCount();
    await setPinned(tdb.db, "primary", { version: 2, pinned: true }, editor, subs);
    expect(await slidesEventCount()).toBe(before + 1);
    const ev = await lastSlidesEvent();
    expect(ev!.data.slides!.some((s) => s.headline === "Alert")).toBe(true);
  });

  it("9. setSlideImage with HTML bytes → SiteRuleError; with a PNG → hasImage true and imageBase64 in the next emitted snapshot", async () => {
    await seedLiveCarousel([slide("Img")]);
    const { live } = await getCarousels(tdb.db);
    const slideId = live!.slides[0]!.id;
    await expect(setSlideImage(tdb.db, slideId, HTML, editor, subs)).rejects.toThrow(/JPEG or PNG/i);

    await setSlideImage(tdb.db, slideId, PNG, editor, subs);
    const { live: reloaded } = await getCarousels(tdb.db);
    expect(reloaded!.slides[0]!.hasImage).toBe(true);
    expect(reloaded!.slides[0]!.imageUrl).toBe(`/nrms/api/site/slides/${slideId}/image`);
    const ev = await lastSlidesEvent();
    expect(ev!.data.slides![0]!.imageBase64).toBe(PNG.toString("base64"));
  });

  it("10. a past carousel can't be saved", async () => {
    await seedLiveCarousel([]);
    const goLiveAt = new Date(t.getTime() + 1000);
    await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
    t = new Date(goLiveAt.getTime() + 1000);
    await switchCarousels(tdb.db, subs, { now });
    const { past } = await getCarousels(tdb.db);
    const pastCarousel = past[0]!;
    await expect(saveCarousel(tdb.db, pastCarousel.id, { version: pastCarousel.version, slides: [] }, editor, subs)).rejects.toThrow(/can't be changed/i);
  });

  it("pins start unpinned at version 1 (seeded by migration 0012)", async () => {
    const pins = await getPins(tdb.db);
    expect(pins).toEqual([
      { slot: "primary", pinned: false, version: 1, slide: expect.objectContaining({ headline: "", hasImage: false, imageUrl: null }) },
      { slot: "secondary", pinned: false, version: 1, slide: expect.objectContaining({ headline: "", hasImage: false, imageUrl: null }) },
    ]);
    const saved = await savePin(tdb.db, "primary", { version: 1, ...slide("First") }, editor, subs);
    expect(saved.version).toBe(2);
    await expect(savePin(tdb.db, "primary", { version: 1, ...slide("Again") }, editor, subs)).rejects.toThrow(SiteConflictError);
  });

  it("two concurrent savePin calls with version 1 → exactly one succeeds, the other gets SiteConflictError", async () => {
    const results = await Promise.allSettled([
      savePin(tdb.db, "primary", { version: 1, ...slide("A") }, editor, subs),
      savePin(tdb.db, "primary", { version: 1, ...slide("B") }, editor, subs),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SiteConflictError);
    const [pin] = await getPins(tdb.db);
    expect(pin!.version).toBe(2);
  });

  it("makeNextLive promotes the next carousel immediately, ignoring go_live_at", async () => {
    await seedLiveCarousel([slide("Old")]);
    const next = await createNextCarousel(tdb.db, { goLiveAt: future(3_600_000) }, editor, subs, TZ);
    expect(await makeNextLive(tdb.db, editor, subs)).toEqual({ switched: true });
    const { live, next: afterNext } = await getCarousels(tdb.db);
    expect(live!.id).toBe(next.id);
    expect(afterNext).toBeNull();
  });

  it("makeNextLive with no next carousel is a not-found error", async () => {
    await expect(makeNextLive(tdb.db, editor, subs)).rejects.toThrow(SiteNotFoundError);
  });

  it("deleteNextCarousel removes the next carousel; a stale version is refused", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    await expect(deleteNextCarousel(tdb.db, next.version + 1, editor)).rejects.toThrow(SiteConflictError);
    await deleteNextCarousel(tdb.db, next.version, editor);
    const { next: gone } = await getCarousels(tdb.db);
    expect(gone).toBeNull();
  });

  it("setPinImage refuses non-image bytes and round-trips a PNG through pinImage", async () => {
    await savePin(tdb.db, "secondary", { version: 1, ...slide("Pic") }, editor, subs);
    await expect(setPinImage(tdb.db, "secondary", HTML, editor, subs)).rejects.toThrow(/JPEG or PNG/i);
    await setPinImage(tdb.db, "secondary", PNG, editor, subs);
    expect(await pinImage(tdb.db, "secondary")).toEqual({ bytes: PNG, mimeType: "image/png" });
  });
});
