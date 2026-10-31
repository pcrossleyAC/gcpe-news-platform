import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbClock, type TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { createNrmsTestDb, editor } from "../../test/helpers";
import { MAX_SITE_IMAGE_BYTES } from "../http/site-routes";
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
  stageSlideImage,
  switchCarousels,
  type SlideInput,
} from "./carousel";
import type { SlideImageFiles } from "./slide-images";
import { SiteConflictError, SiteNotFoundError, SiteRuleError } from "./errors";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["*"] }];
const TZ = "America/Vancouver";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
const HTML = Buffer.from("<html></html>");

const slide = (headline: string, over: Partial<SlideInput> = {}): SlideInput => ({
  headline,
  summary: "",
  actionUrl: "",
  actionLabel: "",
  facebookPostUrl: "",
  justify: "left",
  ...over,
});

describe("home-page carousel", () => {
  let tdb: TestDatabase;
  let t: Date;
  const now = () => t;
  let root: string;
  let store: ObjectStore;
  let files: SlideImageFiles;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    root = await mkdtemp(join(tmpdir(), "nrms-carousel-test-"));
    store = localStore(root, "/files/");
    files = { store, filesBase: "" };
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(root, { recursive: true, force: true });
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
    return r.rows[0]?.envelope as {
      data: { entity: string; slides?: { headline: string | null; actionLabel?: string | null; imageBase64: string | null; imageUrl: string | null; imageKey: string | null; imageSha256: string | null }[] };
    } | undefined;
  };
  const lastLog = async () => {
    const r = await tdb.pool.query("SELECT actor_name, area, text FROM site_log ORDER BY id DESC LIMIT 1");
    return r.rows[0] as { actor_name: string; area: string; text: string } | undefined;
  };

  /** Creates a next carousel with `slides`, then promotes it to live. Returns its id. */
  const seedLiveCarousel = async (slides: SlideInput[]): Promise<string> => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    await saveCarousel(tdb.db, next.id, { version: next.version, slides }, editor, subs, TZ, files);
    await makeNextLive(tdb.db, editor, subs, files);
    return next.id;
  };

  /** Sets live slide images the way the Hub now does (audit #9): staged, then set by the carousel's save. */
  const setLiveImages = async (images: (Buffer | undefined)[]): Promise<void> => {
    const { live } = await getCarousels(tdb.db);
    const uploads = await Promise.all(images.map((b) => (b ? stageSlideImage(files, b).then((r) => r.upload) : undefined)));
    await saveCarousel(tdb.db, live!.id, { version: live!.version, slides: live!.slides.map((sl, i) => ({ ...sl, ...(uploads[i] ? { imageUpload: uploads[i] } : {}) })) }, editor, subs, TZ, files);
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

  // 3f task 5 fix round 1 (controller ruling): goLiveAtLocal (BC wall-clock, no offset)
  // converts server-side with the tenant's own tzdata — a winter date after BC's permanent
  // UTC-7 switch (2026-11-01) must still resolve to UTC-7, not fall back to UTC-8 (requires
  // Node 24+ tzdata) — same pattern as releases/service.test.ts's plannedPublishAtLocal test.
  it("createNextCarousel accepts goLiveAtLocal and converts it server-side, including a winter date after BC's permanent UTC-7 switch", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAtLocal: "2026-12-15T14:30" }, editor, subs, TZ);
    expect(next.goLiveAt).toBe("2026-12-15T21:30:00.000Z"); // 14:30 UTC-7 (permanent BC time) -> 21:30Z, not 22:30Z
  });

  it("saveCarousel accepts goLiveAtLocal and converts it server-side", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    const saved = await saveCarousel(tdb.db, next.id, { version: next.version, goLiveAtLocal: "2026-12-15T14:30", slides: [] }, editor, subs, TZ, files);
    expect(saved.goLiveAt).toBe("2026-12-15T21:30:00.000Z");
  });

  it("saveCarousel: a goLiveAtLocal in the past (BC time) still fails the future check on the converted instant", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    await expect(
      saveCarousel(tdb.db, next.id, { version: next.version, goLiveAtLocal: "2020-01-01T00:00", slides: [] }, editor, subs, TZ, files),
    ).rejects.toThrow(/future/i);
  });

  it("fix round 1: saving the next carousel with a past goLiveAt → SiteRuleError and nothing changes", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    const past = new Date(t.getTime() - 60_000).toISOString();
    await expect(
      saveCarousel(tdb.db, next.id, { version: next.version, goLiveAt: past, slides: [slide("A")] }, editor, subs, TZ, files),
    ).rejects.toThrow(/future/i);
    const { next: reloaded } = await getCarousels(tdb.db);
    expect(reloaded!.version).toBe(next.version);
    expect(reloaded!.goLiveAt).toBe(next.goLiveAt);
    expect(reloaded!.slides).toHaveLength(0);
  });

  it("2. saveCarousel with a stale version → SiteConflictError; nothing changed", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("A")] }, editor, subs, TZ, files);
    await expect(saveCarousel(tdb.db, next.id, { version: next.version, slides: [] }, editor, subs, TZ, files)).rejects.toThrow(SiteConflictError);
    const { next: reloaded } = await getCarousels(tdb.db);
    expect(reloaded!.slides).toHaveLength(1);
    expect(reloaded!.slides[0]!.headline).toBe("A");
  });

  it("3. saving the live carousel emits one site.content.changed 'slides' event; saving the next carousel emits none", async () => {
    await seedLiveCarousel([]);
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);

    const beforeNext = await slidesEventCount();
    await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("N1")] }, editor, subs, TZ, files);
    expect(await slidesEventCount()).toBe(beforeNext);

    const { live } = await getCarousels(tdb.db);
    const beforeLive = await slidesEventCount();
    await saveCarousel(tdb.db, live!.id, { version: live!.version, slides: [slide("L1")] }, editor, subs, TZ, files);
    expect(await slidesEventCount()).toBe(beforeLive + 1);
    const ev = await lastSlidesEvent();
    expect(ev!.data.entity).toBe("slides");
  });

  it("4. switchCarousels before go_live_at does nothing; after it, live→past, next→live, one slides event, logged by System", async () => {
    await seedLiveCarousel([slide("Live1")]);
    const goLiveAt = new Date(t.getTime() + 60_000);
    const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);

    expect(await switchCarousels(tdb.db, subs, files, { now })).toEqual({ switched: false });

    const before = await slidesEventCount();
    t = new Date(goLiveAt.getTime() + 1000);
    expect(await switchCarousels(tdb.db, subs, files, { now })).toEqual({ switched: true });
    expect(await slidesEventCount()).toBe(before + 1);

    const { live, next: afterNext, past } = await getCarousels(tdb.db);
    expect(live!.id).toBe(next.id);
    expect(afterNext).toBeNull();
    expect(past).toHaveLength(1);
    expect(past[0]!.slides[0]!.headline).toBe("Live1");

    const log = await lastLog();
    expect(log).toMatchObject({ actor_name: "System", area: "carousel", text: "The next carousel went live" });
  });

  // Backstop: EventTooLargeError guards any outbox emit over the shared event-size cap, from
  // any cause — not specific to images now that they travel as URLs. A giant text field is
  // enough to trigger it cheaply; switchCarousels must not crash the tick loop on that — it
  // logs once and leaves the next carousel queued (not switched), so it's retried rather than
  // wedging or crash-looping.
  it("switchCarousels: an emit that's still too large (e.g. a giant slide field) logs once and is left queued, not switched", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedLiveCarousel([]);
      const goLiveAt = new Date(t.getTime() + 1000);
      const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
      await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("Big", { summary: "x".repeat(1_100_000) })] }, editor, subs, TZ, files);

      t = new Date(goLiveAt.getTime() + 1000);
      expect(await switchCarousels(tdb.db, subs, files, { now })).toEqual({ switched: false });
      expect(errSpy).toHaveBeenCalled();

      const { next: stillNext, live } = await getCarousels(tdb.db);
      expect(stillNext!.id).toBe(next.id); // left in place — the switch rolled back
      expect(live!.slides).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("5. after seven switch-overs exactly five past carousels remain and their slides are deleted with them", async () => {
    await seedLiveCarousel([slide("Seed")]);
    for (let i = 0; i < 7; i++) {
      const goLiveAt = new Date(t.getTime() + 1000);
      const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
      await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide(`N${i}`)] }, editor, subs, TZ, files);
      t = new Date(goLiveAt.getTime() + 1000);
      expect(await switchCarousels(tdb.db, subs, files, { now })).toEqual({ switched: true });
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
    const results = await Promise.all([switchCarousels(tdb.db, subs, files, { now }), switchCarousels(tdb.db, subs, files, { now })]);
    expect(results.filter((r) => r.switched)).toHaveLength(1);
    expect(results.filter((r) => !r.switched)).toHaveLength(1);
  });

  it("7. pinned primary + secondary survive a switch-over and appear at -2/-1 in the emitted slides (C21)", async () => {
    await savePin(tdb.db, "primary", { version: 1, ...slide("P1") }, editor, subs, files);
    await setPinned(tdb.db, "primary", { version: 2, pinned: true }, editor, subs, files);
    await savePin(tdb.db, "secondary", { version: 1, ...slide("S1") }, editor, subs, files);
    await setPinned(tdb.db, "secondary", { version: 2, pinned: true }, editor, subs, files);

    await seedLiveCarousel([slide("Live1")]);
    const goLiveAt = new Date(t.getTime() + 1000);
    const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
    await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("Next1")] }, editor, subs, TZ, files);
    t = new Date(goLiveAt.getTime() + 1000);
    await switchCarousels(tdb.db, subs, files, { now });

    const ev = await lastSlidesEvent();
    expect(ev!.data.slides!.map((s) => s.headline)).toEqual(["P1", "S1", "Next1"]);
  });

  it("saves a slide's actionLabel (trimmed) and emits it; '' emits null", async () => {
    await seedLiveCarousel([slide("A", { actionLabel: "  Read the update  " }), slide("B")]);
    const { live } = await getCarousels(tdb.db);
    expect(live!.slides.map((s) => s.actionLabel)).toEqual(["Read the update", ""]);
    const ev = await lastSlidesEvent();
    expect(ev!.data.slides!.map((s) => s.actionLabel)).toEqual(["Read the update", null]);
  });

  it("refuses a 41-character or '<b>' action label on a slide and on a pin, and changes nothing", async () => {
    await seedLiveCarousel([slide("A")]);
    const live = (await getCarousels(tdb.db)).live!;
    for (const actionLabel of ["x".repeat(41), "<b>Bold</b>", "a > b"]) {
      await expect(saveCarousel(tdb.db, live.id, { version: live.version, slides: [slide("A", { actionLabel })] }, editor, subs, TZ, files)).rejects.toThrow(
        new SiteRuleError(["Keep the action label to 40 characters or fewer, in plain text."]),
      );
      await expect(savePin(tdb.db, "primary", { version: 1, ...slide("P", { actionLabel }) }, editor, subs, files)).rejects.toThrow(SiteRuleError);
    }
    const ok = await saveCarousel(tdb.db, live.id, { version: live.version, slides: [slide("A", { actionLabel: "x".repeat(40) })] }, editor, subs, TZ, files);
    expect(ok.slides[0]!.actionLabel).toBe("x".repeat(40));
    expect((await getPins(tdb.db))[0]!.version).toBe(1);
  });

  it("pins carry actionLabel the same way", async () => {
    const saved = await savePin(tdb.db, "primary", { version: 1, ...slide("Alert", { actionLabel: " Get help " }) }, editor, subs, files);
    expect(saved.slide.actionLabel).toBe("Get help");
    await setPinned(tdb.db, "primary", { version: 2, pinned: true }, editor, subs, files);
    await savePin(tdb.db, "secondary", { version: 1, ...slide("Second") }, editor, subs, files);
    await setPinned(tdb.db, "secondary", { version: 2, pinned: true }, editor, subs, files);
    const ev = await lastSlidesEvent();
    expect(ev!.data.slides!.map((s) => [s.headline, s.actionLabel])).toEqual([["Alert", "Get help"], ["Second", null]]);
  });

  it("8. setPinned true without a headline → SiteRuleError; with one → slides event includes the pin", async () => {
    await expect(setPinned(tdb.db, "primary", { version: 1, pinned: true }, editor, subs, files)).rejects.toThrow(/headline/i);
    await savePin(tdb.db, "primary", { version: 1, ...slide("Alert") }, editor, subs, files);
    const before = await slidesEventCount();
    await setPinned(tdb.db, "primary", { version: 2, pinned: true }, editor, subs, files);
    expect(await slidesEventCount()).toBe(before + 1);
    const ev = await lastSlidesEvent();
    expect(ev!.data.slides!.some((s) => s.headline === "Alert")).toBe(true);
  });

  it("9. a slide image with HTML bytes → SiteRuleError; with a PNG → hasImage true and a content-addressed URL in the next emitted snapshot, imageBase64 null", async () => {
    await seedLiveCarousel([slide("Img")]);
    const { live } = await getCarousels(tdb.db);
    const slideId = live!.slides[0]!.id;
    await expect(stageSlideImage(files, HTML)).rejects.toThrow(/JPEG or PNG/i);

    await setLiveImages([PNG]);
    const { live: reloaded } = await getCarousels(tdb.db);
    expect(reloaded!.slides[0]!.hasImage).toBe(true);
    // This is the staff-facing authenticated route, distinct from the public imageUrl below.
    expect(reloaded!.slides[0]!.imageUrl).toBe(`/nrms/api/site/slides/${slideId}/image`);
    const sha = createHash("sha256").update(PNG).digest("hex");
    const ev = await lastSlidesEvent();
    expect(ev!.data.slides![0]!.imageBase64).toBeNull();
    expect(ev!.data.slides![0]!.imageKey).toBe(`slides/${sha}.png`);
    expect(ev!.data.slides![0]!.imageUrl).toBe(`/files/slides/${sha}.png`);
    expect(ev!.data.slides![0]!.imageSha256).toBe(sha);
    expect((await store.get(`slides/${sha}.png`))!.bytes.equals(PNG)).toBe(true);
  });

  describe("audit #9: a slide's image goes with the carousel's save", () => {
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

    it("staging an image stores its file but changes nothing public and logs nothing", async () => {
      await seedLiveCarousel([slide("Live")]);
      const events = await slidesEventCount();
      const log = await lastLog();
      const { upload } = await stageSlideImage(files, PNG);
      expect(upload).toBe(`${sha(PNG)}.png`);
      expect((await store.get(`slides/${sha(PNG)}.png`))!.bytes.equals(PNG)).toBe(true);
      expect(await slidesEventCount()).toBe(events);
      expect(await lastLog()).toEqual(log);
      const { live } = await getCarousels(tdb.db);
      expect(live!.slides[0]!.hasImage).toBe(false);
    });

    it("staging refuses a file that isn't a JPEG or PNG", async () => {
      await expect(stageSlideImage(files, HTML)).rejects.toThrow(SiteRuleError);
    });

    it("a new slide on the live carousel publishes with its image in one change", async () => {
      const liveId = await seedLiveCarousel([slide("Old")]);
      const { live } = await getCarousels(tdb.db);
      const { upload } = await stageSlideImage(files, PNG);
      const events = await slidesEventCount();
      const saved = await saveCarousel(tdb.db, liveId, { version: live!.version, slides: [{ ...slide("Old"), id: live!.slides[0]!.id }, slide("New", { imageUpload: upload })] }, editor, subs, TZ, files);
      expect(saved.slides.map((s) => [s.headline, s.hasImage])).toEqual([["Old", false], ["New", true]]);
      expect(await slidesEventCount()).toBe(events + 1);
      const ev = await lastSlidesEvent();
      expect(ev!.data.slides![1]!.headline).toBe("New");
      expect(ev!.data.slides![1]!.imageKey).toBe(`slides/${sha(PNG)}.png`);
      expect((await slideImage(tdb.db, saved.slides[1]!.id))!.bytes.equals(PNG)).toBe(true);
    });

    it("an image change on a live slide waits for the carousel's save", async () => {
      const liveId = await seedLiveCarousel([slide("Live")]);
      const { live } = await getCarousels(tdb.db);
      const { upload } = await stageSlideImage(files, PNG);
      const saved = await saveCarousel(tdb.db, liveId, { version: live!.version, slides: [{ ...slide("Live"), id: live!.slides[0]!.id, imageUpload: upload }] }, editor, subs, TZ, files);
      expect(saved.slides[0]!.hasImage).toBe(true);
      expect((await lastSlidesEvent())!.data.slides![0]!.imageKey).toBe(`slides/${sha(PNG)}.png`);
    });

    it("a slide saved without imageUpload keeps its image", async () => {
      const liveId = await seedLiveCarousel([slide("Live")]);
      const { live } = await getCarousels(tdb.db);
      const { upload } = await stageSlideImage(files, PNG);
      const once = await saveCarousel(tdb.db, liveId, { version: live!.version, slides: [{ ...slide("Live"), id: live!.slides[0]!.id, imageUpload: upload }] }, editor, subs, TZ, files);
      const twice = await saveCarousel(tdb.db, liveId, { version: once.version, slides: [{ ...slide("Live again"), id: once.slides[0]!.id }] }, editor, subs, TZ, files);
      expect(twice.slides[0]!.hasImage).toBe(true);
    });

    it("an upload that isn't in the store, or isn't a JPEG or PNG under 2 MB, is refused and nothing is saved", async () => {
      const liveId = await seedLiveCarousel([slide("Live")]);
      const { live } = await getCarousels(tdb.db);
      const events = await slidesEventCount();
      const missing = `${"0".repeat(64)}.png`;
      await expect(saveCarousel(tdb.db, liveId, { version: live!.version, slides: [slide("New", { imageUpload: missing })] }, editor, subs, TZ, files)).rejects.toThrow(/choose slide 1.s image again/i);
      // Bytes under a slides/ key that don't match their name (or aren't an image) are refused too.
      await store.put(`slides/${"1".repeat(64)}.png`, HTML, "image/png");
      await expect(saveCarousel(tdb.db, liveId, { version: live!.version, slides: [slide("New", { imageUpload: `${"1".repeat(64)}.png` })] }, editor, subs, TZ, files)).rejects.toThrow(SiteRuleError);
      const big = Buffer.concat([PNG, Buffer.alloc(MAX_SITE_IMAGE_BYTES)]);
      await store.put(`slides/${sha(big)}.png`, big, "image/png");
      await expect(saveCarousel(tdb.db, liveId, { version: live!.version, slides: [slide("New", { imageUpload: `${sha(big)}.png` })] }, editor, subs, TZ, files)).rejects.toThrow(/2 MB/);
      expect(await slidesEventCount()).toBe(events);
      expect((await getCarousels(tdb.db)).live!.slides.map((s) => s.headline)).toEqual(["Live"]);
    });

    it("setSlideImage no longer changes a live slide straight away: it's refused and nothing is emitted", async () => {
      await seedLiveCarousel([slide("Live")]);
      const { live } = await getCarousels(tdb.db);
      const events = await slidesEventCount();
      await expect(setSlideImage(tdb.db, live!.slides[0]!.id, PNG, editor, subs, files)).rejects.toThrow(SiteConflictError);
      expect(await slidesEventCount()).toBe(events);
      expect((await getCarousels(tdb.db)).live!.slides[0]!.hasImage).toBe(false);
    });

    it("setSlideImage still sets a next carousel's slide image", async () => {
      const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
      const saved = await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("N")] }, editor, subs, TZ, files);
      await setSlideImage(tdb.db, saved.slides[0]!.id, PNG, editor, subs, files);
      expect((await getCarousels(tdb.db)).next!.slides[0]!.hasImage).toBe(true);
    });
  });

  it("10. a past carousel can't be saved", async () => {
    await seedLiveCarousel([]);
    const goLiveAt = new Date(t.getTime() + 1000);
    await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
    t = new Date(goLiveAt.getTime() + 1000);
    await switchCarousels(tdb.db, subs, files, { now });
    const { past } = await getCarousels(tdb.db);
    const pastCarousel = past[0]!;
    await expect(saveCarousel(tdb.db, pastCarousel.id, { version: pastCarousel.version, slides: [] }, editor, subs, TZ, files)).rejects.toThrow(/can't be changed/i);
  });

  it("pins start unpinned at version 1 (seeded by migration 0012)", async () => {
    const pins = await getPins(tdb.db);
    expect(pins).toEqual([
      { slot: "primary", pinned: false, version: 1, slide: expect.objectContaining({ headline: "", hasImage: false, imageUrl: null }) },
      { slot: "secondary", pinned: false, version: 1, slide: expect.objectContaining({ headline: "", hasImage: false, imageUrl: null }) },
    ]);
    const saved = await savePin(tdb.db, "primary", { version: 1, ...slide("First") }, editor, subs, files);
    expect(saved.version).toBe(2);
    await expect(savePin(tdb.db, "primary", { version: 1, ...slide("Again") }, editor, subs, files)).rejects.toThrow(SiteConflictError);
  });

  it("two concurrent savePin calls with version 1 → exactly one succeeds, the other gets SiteConflictError", async () => {
    const results = await Promise.allSettled([
      savePin(tdb.db, "primary", { version: 1, ...slide("A") }, editor, subs, files),
      savePin(tdb.db, "primary", { version: 1, ...slide("B") }, editor, subs, files),
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
    expect(await makeNextLive(tdb.db, editor, subs, files)).toEqual({ switched: true });
    const { live, next: afterNext } = await getCarousels(tdb.db);
    expect(live!.id).toBe(next.id);
    expect(afterNext).toBeNull();
  });

  it("makeNextLive with no next carousel is a not-found error", async () => {
    await expect(makeNextLive(tdb.db, editor, subs, files)).rejects.toThrow(SiteNotFoundError);
  });

  it("deleteNextCarousel removes the next carousel; a stale version is refused", async () => {
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    await expect(deleteNextCarousel(tdb.db, next.version + 1, editor)).rejects.toThrow(SiteConflictError);
    await deleteNextCarousel(tdb.db, next.version, editor);
    const { next: gone } = await getCarousels(tdb.db);
    expect(gone).toBeNull();
  });

  it("setPinImage refuses non-image bytes and round-trips a PNG through pinImage", async () => {
    await savePin(tdb.db, "secondary", { version: 1, ...slide("Pic") }, editor, subs, files);
    await expect(setPinImage(tdb.db, "secondary", HTML, editor, subs, files)).rejects.toThrow(/JPEG or PNG/i);
    await setPinImage(tdb.db, "secondary", PNG, editor, subs, files);
    expect(await pinImage(tdb.db, "secondary")).toEqual({ bytes: PNG, mimeType: "image/png" });
  });

  // Minor 2: a bare pre-check SELECT locks nothing when no "next" row exists yet, so two
  // concurrent first-ever creates could both pass it and both reach the INSERT, the loser
  // hitting the raw carousels_one_next_idx unique violation as a bare 500. createNextCarousel
  // now inserts directly and maps that violation to SiteConflictError.
  it("two concurrent createNextCarousel calls → exactly one succeeds, the other gets SiteConflictError (minor 2)", async () => {
    const results = await Promise.allSettled([
      createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ),
      createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SiteConflictError);
    const { next } = await getCarousels(tdb.db);
    expect(next).not.toBeNull();
  });

  // Minor 3: setSlideImage now locks the slide's carousel row (SELECT … FOR UPDATE) before
  // writing the image, so it can't race a concurrent switch-over and have its write land after
  // the switch has already read (and emitted) the slides without it.
  it("setSlideImage blocks until a concurrent lock on its carousel row is released (minor 3)", async () => {
    // A next carousel's slide: the race is with the switch-over that makes it live.
    const next = await createNextCarousel(tdb.db, { goLiveAt: future() }, editor, subs, TZ);
    const live = await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("Img")] }, editor, subs, TZ, files);
    const slideId = live.slides[0]!.id;

    const client = await tdb.pool.connect();
    let settled = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM carousels WHERE id = $1 FOR UPDATE", [live.id]);

      const setPromise = setSlideImage(tdb.db, slideId, PNG, editor, subs, files).then(() => {
        settled = true;
      });

      // setSlideImage must not be able to complete while this transaction still holds the
      // carousel row's lock.
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false);

      await client.query("COMMIT");
      await setPromise;
      expect(settled).toBe(true);
    } finally {
      client.release();
    }
    const { next: reloaded } = await getCarousels(tdb.db);
    expect(reloaded!.slides[0]!.hasImage).toBe(true);
  });

  describe("content-addressed slide images (the event-size budget is retired, C42)", () => {
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    /** A valid-looking PNG (header + padding) of exactly `totalBytes`. */
    const bigImage = (totalBytes: number): Buffer => Buffer.concat([PNG_HEADER, Buffer.alloc(Math.max(0, totalBytes - PNG_HEADER.length))]);
    const IMAGE_URL = /^\/files\/slides\/[0-9a-f]{64}\.png$/;

    const lastEnvelopeBytes = async (): Promise<number> => {
      const r = await tdb.pool.query("SELECT envelope FROM outbox_events WHERE type = 'site.content.changed' ORDER BY created_at DESC, sequence DESC LIMIT 1");
      return Buffer.byteLength(JSON.stringify(r.rows[0].envelope));
    };

    it("ten 2 MB slide images save, and the slides event stays small", async () => {
      await seedLiveCarousel(Array.from({ length: 10 }, (_, i) => slide(`S${i}`)));
      await setLiveImages(Array.from({ length: 10 }, () => bigImage(MAX_SITE_IMAGE_BYTES)));

      expect(await lastEnvelopeBytes()).toBeLessThan(10 * 1024);

      const ev = await lastSlidesEvent();
      expect(ev!.data.slides).toHaveLength(10);
      for (const s of ev!.data.slides!) {
        expect(s.imageBase64).toBeNull();
        expect(s.imageUrl).toMatch(IMAGE_URL);
      }
      const { live: reloaded } = await getCarousels(tdb.db);
      for (const s of reloaded!.slides) expect(s.hasImage).toBe(true);
    });

    it("two slides with the same image share one file", async () => {
      await seedLiveCarousel([slide("A"), slide("B")]);
      const bytes = bigImage(2048);
      const before = await store.list("slides/");

      await setLiveImages([bytes, bytes]);

      const ev = await lastSlidesEvent();
      expect(ev!.data.slides![0]!.imageKey).toBe(ev!.data.slides![1]!.imageKey);
      // Both writes landed on the same content-addressed key: exactly one new file, not two.
      expect((await store.list("slides/")).length - before.length).toBe(1);
    });

    it("switching carousels emits URLs for the new live carousel's images", async () => {
      await seedLiveCarousel([]);
      const goLiveAt = new Date(t.getTime() + 1000);
      const next = await createNextCarousel(tdb.db, { goLiveAt: goLiveAt.toISOString() }, editor, subs, TZ);
      await saveCarousel(tdb.db, next.id, { version: next.version, slides: [slide("N1")] }, editor, subs, TZ, files);
      const { next: withSlide } = await getCarousels(tdb.db);
      await setSlideImage(tdb.db, withSlide!.slides[0]!.id, bigImage(1024), editor, subs, files);

      t = new Date(goLiveAt.getTime() + 1000);
      expect(await switchCarousels(tdb.db, subs, files, { now })).toEqual({ switched: true });
      const ev = await lastSlidesEvent();
      expect(ev!.data.slides![0]!.headline).toBe("N1");
      expect(ev!.data.slides![0]!.imageUrl).toMatch(IMAGE_URL);
    });
  });
});
