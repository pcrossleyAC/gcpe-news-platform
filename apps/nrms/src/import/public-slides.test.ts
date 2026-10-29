import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbClock, type TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { localStore } from "@gcpe/storage";
import { INTERNAL_EVENT_ROUTES } from "../../../stack/src/env";
import { createNrmsTestDb, editor } from "../../test/helpers";
import { createNextCarousel, makeNextLive, saveCarousel, setSlideImage, type SlideInput } from "../website/carousel";
import { slidesSnapshot } from "../website/events";
import { MAX_SITE_IMAGE_BYTES, type SlideImageFiles } from "../website/slide-images";
import {
  decodeBase64Strict,
  fetchPublicSlides,
  IMPORT_LOG_TEXT,
  mapPublicSlides,
  MAX_BASE64_IMAGE_CHARS,
  MAX_RESPONSE_BYTES,
  PUBLIC_SLIDES_USER_AGENT,
  runPublicSlides,
  STACK_SITE_SUBSCRIBERS,
  type FetchedSlides,
  type PublicSlidesOptions,
} from "./public-slides";
import { bareEnvWarnings, filesBaseFromEnv, parsePublicSlidesArgs, storageDirFromEnv, subscribersFromEnv } from "./public-slides-options";

/** news.gov's GET /api/Slides as recorded 2026-10-28, images swapped for tiny generated PNG/JPEGs. */
const FIXTURE = JSON.parse(readFileSync(new URL("../../test/fixtures/public-slides.json", import.meta.url), "utf8")) as Record<string, unknown>[];
const KEYS = FIXTURE.map((s) => String(s.key));
const fixture = () => structuredClone(FIXTURE);
const PNG_B64 = String(FIXTURE[0]!.image);
const JPEG_B64 = String(FIXTURE[1]!.image);
const TZ = "America/Vancouver";
const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s".repeat(40), types: ["site.content.changed"] }];

describe("import:public-slides — mapping and validation", () => {
  it("maps every field in the source's order (= carousel order)", async () => {
    const { slides, refused, warnings } = await mapPublicSlides(fixture());
    expect(refused).toEqual([]);
    expect(warnings).toEqual([]);
    expect(slides.map((s) => s.key)).toEqual(KEYS);
    expect(slides.map((s) => s.headline)).toEqual(["Get vaccinated", "EmergencyInfoBC", "Emergency Support Services", "Drought in B.C.\u00a0"]);
    const first = slides[0]!;
    expect(first).toMatchObject({
      summary: "Find out where you and your family can get vaccinated.",
      actionUrl: "https://www.healthlinkbc.ca/health-library/immunizations/schedules/where-get-immunized",
      actionLabel: "READ MORE",
      facebookPostUrl: "", // facebookPostUri null
      justify: "right",
      imageType: "image/png",
    });
    expect(first.image!.equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    expect(slides.slice(1).every((s) => s.imageType === "image/jpeg")).toBe(true);
  });

  it("justify: case-insensitive; missing or unknown falls back to left with a warning", async () => {
    const list = fixture();
    list[0]!.justify = "Left";
    list[1]!.justify = null;
    list[2]!.justify = "centre";
    const { slides, warnings } = await mapPublicSlides(list);
    expect(slides.map((s) => s.justify)).toEqual(["left", "left", "left", "right"]);
    expect(warnings.map((w) => w.index)).toEqual([1, 2]);
  });

  it("actionLabel: trimmed; missing → empty (the site shows its default); over 40 characters or markup → empty, with a warning", async () => {
    const list = fixture();
    list[0]!.actionLabel = null;
    list[1]!.actionLabel = "  Apply now  ";
    list[2]!.actionLabel = "x".repeat(41);
    list[3]!.actionLabel = "<b>Go</b>";
    const { slides, warnings } = await mapPublicSlides(list);
    expect(slides.map((s) => s.actionLabel)).toEqual(["", "Apply now", "", ""]);
    expect(warnings.map((w) => w.index)).toEqual([2, 3]);
  });

  it("a facebookPostUri is kept; null/missing becomes empty", async () => {
    const list = fixture();
    list[0]!.facebookPostUri = "https://www.facebook.com/BCProvincialGovernment/posts/1";
    delete list[1]!.facebookPostUri;
    const { slides } = await mapPublicSlides(list);
    expect(slides[0]!.facebookPostUrl).toBe("https://www.facebook.com/BCProvincialGovernment/posts/1");
    expect(slides[1]!.facebookPostUrl).toBe("");
  });

  it("refuses (and reports) a slide with bad base64, a type mismatch, an oversize image or a non-image; the rest still import", async () => {
    const list = fixture();
    list[0]!.image = "not*base64!";
    list[1]!.imageType = "image/png"; // JPEG bytes declared PNG
    const big = Buffer.alloc(MAX_SITE_IMAGE_BYTES + 1);
    Buffer.from(PNG_B64, "base64").copy(big);
    list[2]!.image = big.toString("base64");
    list[2]!.imageType = "image/png";
    list.push({ ...list[3]!, key: "11111111-1111-4111-8111-111111111111", image: Buffer.from("GIF89a....").toString("base64"), imageType: "image/gif" });
    const { slides, refused } = await mapPublicSlides(list);
    expect(slides.map((s) => s.key)).toEqual([KEYS[3]]);
    expect(refused.map((r) => [r.index, r.key])).toEqual([
      [0, KEYS[0]],
      [1, KEYS[1]],
      [2, KEYS[2]],
      [4, "11111111-1111-4111-8111-111111111111"],
    ]);
    expect(refused[0]!.reasons).toEqual(["image is not valid base64"]);
    expect(refused[1]!.reasons).toEqual(['imageType is "image/png" but the bytes are image/jpeg']);
    expect(refused[2]!.reasons[0]).toMatch(/over the Hub's 2097152-byte limit/);
    expect(refused[3]!.reasons).toEqual(["image is not a JPEG or PNG (by its bytes)"]);
  });

  it("an image at exactly the Hub's limit is accepted", async () => {
    const exact = Buffer.alloc(MAX_SITE_IMAGE_BYTES);
    Buffer.from(PNG_B64, "base64").copy(exact);
    const list = [{ ...fixture()[0]!, image: exact.toString("base64") }];
    expect((await mapPublicSlides(list)).slides).toHaveLength(1);
  });

  it("refuses what the Hub's save would: a non-http action URL, a headline over 255, a bad or duplicate key", async () => {
    const list = fixture();
    list[0]!.actionUri = "javascript:alert(1)";
    list[1]!.headline = "h".repeat(256);
    list[2]!.key = "not-a-guid";
    list[3]!.key = KEYS[0]!.toUpperCase(); // same key as slide 0, which is itself refused…
    list.push({ ...fixture()[3]! }, { ...fixture()[3]! }); // …so this one is first with KEYS[3]; the next is a duplicate
    const { slides, refused } = await mapPublicSlides(list);
    expect(slides.map((s) => s.key)).toEqual([KEYS[0], KEYS[3]]);
    expect(refused.map((r) => r.index)).toEqual([0, 1, 2, 5]);
    expect(refused[0]!.reasons[0]).toMatch(/^actionUrl: must be an absolute http/);
    expect(refused[3]!.reasons).toEqual(["duplicate key (an earlier slide has it)"]);
  });

  it("refuses an image whose base64 text is too long before decoding it; the rest still import", async () => {
    const list = fixture();
    list[0]!.image = "A".repeat(MAX_BASE64_IMAGE_CHARS + 1);
    const { slides, refused } = await mapPublicSlides(list);
    expect(slides).toHaveLength(3);
    expect(refused[0]!.reasons).toEqual([`image's base64 text is ${MAX_BASE64_IMAGE_CHARS + 1} characters, over the ${MAX_BASE64_IMAGE_CHARS} a 2 MiB image needs`]);
    expect(MAX_BASE64_IMAGE_CHARS).toBe(Math.ceil((MAX_SITE_IMAGE_BYTES * 4) / 3) + 8);
  });

  it("accepts imageType image/jpg as image/jpeg", async () => {
    const list = fixture();
    list[1]!.imageType = "image/jpg";
    const { slides, refused } = await mapPublicSlides(list);
    expect(refused).toEqual([]);
    expect(slides[1]!.imageType).toBe("image/jpeg");
  });

  it("decodeBase64Strict refuses what Buffer.from would silently skip", () => {
    expect(decodeBase64Strict("QUJD")?.toString()).toBe("ABC");
    expect(decodeBase64Strict("QU JD\n")?.toString()).toBe("ABC");
    expect(decodeBase64Strict("QU*D")).toBeNull();
    expect(decodeBase64Strict("QUJ")).toBeNull();
  });
});

describe("import:public-slides — fetch, options and environment", () => {
  it("fetches once, with the polite User-Agent, and refuses anything but a JSON list", async () => {
    const calls: { url: string; ua: string | null }[] = [];
    const fake = (status: number, body: string) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), ua: new Headers(init?.headers).get("user-agent") });
        return new Response(body, { status });
      }) as typeof fetch;
    const ok = await fetchPublicSlides("https://api.example/", { fetchImpl: fake(200, JSON.stringify(FIXTURE)) });
    expect(ok.body).toHaveLength(4);
    expect(calls).toEqual([{ url: "https://api.example/api/Slides?api-version=1.0", ua: PUBLIC_SLIDES_USER_AGENT }]);
    await expect(fetchPublicSlides("https://api.example", { fetchImpl: fake(429, "") })).rejects.toThrow(/429/);
    await expect(fetchPublicSlides("https://api.example", { fetchImpl: fake(500, "") })).rejects.toThrow(/500/);
    await expect(fetchPublicSlides("https://api.example", { fetchImpl: fake(200, "{}") })).rejects.toThrow(/not a list/);
    await expect(fetchPublicSlides("https://api.example", { fetchImpl: fake(200, "<html>") })).rejects.toThrow(/not JSON/);
    expect(calls).toHaveLength(5);
    // A body over the cap is refused, whatever it holds.
    await expect(fetchPublicSlides("https://api.example", { fetchImpl: fake(200, JSON.stringify(FIXTURE)), maxBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes/);
    expect(MAX_RESPONSE_BYTES).toBe(20 * 1024 * 1024);
  });

  it("parses flags and rejects unknown ones", () => {
    expect(parsePublicSlidesArgs([])).toEqual({ from: "https://api.news.gov.bc.ca", dryRun: false, remove: false, replace: false });
    expect(parsePublicSlidesArgs(["--dry-run", "--replace", "--from=http://localhost:9/"])).toEqual({ from: "http://localhost:9", dryRun: true, remove: false, replace: true });
    expect(parsePublicSlidesArgs(["--remove", "--dry-run"])).toMatchObject({ remove: true, dryRun: true });
    expect(() => parsePublicSlidesArgs(["--remove", "--from", "https://x"])).toThrow(/--remove takes no --from/);
    expect(() => parsePublicSlidesArgs(["--force"])).toThrow(/Unknown argument/);
    expect(() => parsePublicSlidesArgs(["--from", "ftp://x"])).toThrow(/http/);
    expect(() => parsePublicSlidesArgs(["postgres://u:p@h/db"])).toThrow(/Unknown argument/);
  });

  it("finds NRMS's file store and image URL origin as the stack does", () => {
    expect(storageDirFromEnv({ HOME: "/home/u" })).toMatch(/gcpe-data[/\\]storage$/);
    expect(storageDirFromEnv({ DATA_DIR: "/srv/data" })).toBe(join("/srv/data", "storage"));
    expect(storageDirFromEnv({ DATA_DIR: "/srv/data", NRMS_STORAGE_DIR: "/x" })).toBe("/x");
    expect(filesBaseFromEnv({ SITE_PUBLIC_SITE_URL: "https://boxs.ca/site" })).toBe("https://boxs.ca");
    expect(filesBaseFromEnv({ NRMS_PUBLIC_FILES_BASE: "https://files.example/", SITE_PUBLIC_SITE_URL: "https://boxs.ca" })).toBe("https://files.example");
    expect(filesBaseFromEnv({})).toBeNull();
  });

  it("uses only the stack's names (NRMS_STORAGE_DIR, NRMS_PUBLIC_FILES_BASE) and warns when a bare one differs", () => {
    const env = { DATA_DIR: "/srv/data", STORAGE_DIR: "/elsewhere", PUBLIC_FILES_BASE: "https://other.example", SITE_PUBLIC_SITE_URL: "https://boxs.ca" };
    expect(storageDirFromEnv(env)).toBe(join("/srv/data", "storage"));
    expect(filesBaseFromEnv(env)).toBe("https://boxs.ca");
    expect(bareEnvWarnings(env)).toEqual([
      `STORAGE_DIR=/elsewhere is ignored (the stack reads NRMS_STORAGE_DIR); using ${join("/srv/data", "storage")}`,
      "PUBLIC_FILES_BASE=https://other.example is ignored (the stack reads NRMS_PUBLIC_FILES_BASE); using https://boxs.ca",
    ]);
    expect(bareEnvWarnings({ DATA_DIR: "/srv/data", STORAGE_DIR: join("/srv/data", "storage") })).toEqual([]);
  });

  it("the default subscribers are the stack's own NRMS route for site.content.changed, and only that", () => {
    const stack = INTERNAL_EVENT_ROUTES.filter((r) => r.from === "NRMS" && (r.types as readonly string[]).includes("site.content.changed"));
    expect(stack.map((r) => r.name)).toEqual(STACK_SITE_SUBSCRIBERS.map((s) => s.name));
    expect(STACK_SITE_SUBSCRIBERS.flatMap((s) => s.types)).toEqual(["site.content.changed"]);
    expect(subscribersFromEnv({})).toBe(STACK_SITE_SUBSCRIBERS);
    expect(subscribersFromEnv({ NRMS_EVENT_SUBSCRIBERS: JSON.stringify(subs) })).toEqual(subs);
  });
});

describe("import:public-slides — the database", () => {
  let tdb: TestDatabase;
  let root: string;
  let files: SlideImageFiles;
  let fetches: number;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE carousels, slides, emergency_pins, site_log, outbox_events, outbox_deliveries, aggregate_sequences, public_import_carousel, public_import_slides CASCADE");
    await tdb.pool.query("INSERT INTO emergency_pins (slot) VALUES ('primary'), ('secondary')");
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "nrms-public-slides-"));
    files = { store: localStore(root, "/files/"), filesBase: "https://boxs.test" };
    fetches = 0;
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const opts = (o: Partial<PublicSlidesOptions> = {}): PublicSlidesOptions => ({ from: "https://api.example", dryRun: false, remove: false, replace: false, ...o });
  const run = (o: Partial<PublicSlidesOptions> = {}, list: unknown[] = fixture(), withDb = true) =>
    runPublicSlides(
      {
        db: withDb ? tdb.db : null,
        fetchSlides: async (): Promise<FetchedSlides> => {
          fetches++;
          return { url: "https://api.example/api/Slides?api-version=1.0", status: 200, body: list };
        },
        subscribers: subs,
        files,
      },
      opts(o),
    );

  /** Every carousel and slide column, timestamps at full (microsecond) precision. */
  const state = async () => ({
    carousels: (await tdb.pool.query("SELECT id, state, go_live_at::text, went_live_at::text, version, created_at::text, updated_at::text FROM carousels ORDER BY id")).rows,
    slides: (
      await tdb.pool.query(
        "SELECT id, carousel_id, sort_index, headline, summary, action_url, action_label, facebook_post_url, justify, encode(sha256(image), 'hex') AS image, image_type, updated_at::text FROM slides ORDER BY id",
      )
    ).rows,
  });
  const outbox = async () =>
    (await tdb.pool.query("SELECT type, aggregate_id, envelope FROM outbox_events ORDER BY created_at, sequence")).rows as { type: string; aggregate_id: string; envelope: { source: string; data: unknown } }[];
  const deliveries = async () => (await tdb.pool.query("SELECT DISTINCT subscriber FROM outbox_deliveries ORDER BY 1")).rows.map((r) => r.subscriber as string);
  const logs = async () => (await tdb.pool.query("SELECT actor_id, area, text FROM site_log ORDER BY id")).rows as { actor_id: string; area: string; text: string }[];
  const storedFiles = async () => (await readdir(join(root, "slides")).catch(() => [] as string[])).sort();
  const liveHeadlines = async () =>
    (await tdb.pool.query("SELECT s.headline FROM slides s JOIN carousels c ON c.id = s.carousel_id WHERE c.state = 'live' ORDER BY s.sort_index")).rows.map((r) => r.headline as string);

  const hubSlide = (headline: string): SlideInput => ({ headline, summary: "", actionUrl: "", actionLabel: "", facebookPostUrl: "", justify: "left" });
  /** A live carousel made through the Hub (create next, save, make live) by a staff editor. */
  const hubLive = async (headlines: string[]) => {
    const t = await dbClock(tdb.db);
    const next = await createNextCarousel(tdb.db, { goLiveAt: new Date(t.getTime() + 60_000).toISOString() }, editor, subs, TZ);
    await saveCarousel(tdb.db, next.id, { version: next.version, slides: headlines.map(hubSlide) }, editor, subs, TZ, files);
    await makeNextLive(tdb.db, editor, subs, files);
    return next.id;
  };
  /** The same carousel as an SQL import would have left it: rows only, no site_log, no events. */
  const sqlImportedLive = async (headline: string) => {
    const { rows } = await tdb.pool.query("INSERT INTO carousels (state, went_live_at) VALUES ('live', now() - interval '1 day') RETURNING id");
    await tdb.pool.query("INSERT INTO slides (carousel_id, sort_index, headline) VALUES ($1, 0, $2)", [rows[0].id, headline]);
    return rows[0].id as string;
  };

  it("imports the slides as the live carousel, publishing exactly as the Hub's 'Make live now' does", async () => {
    const report = await run();
    expect(report.failed).toBe(false);
    expect(report.write).toMatchObject({ action: "create", replaces: null });
    expect(fetches).toBe(1);
    expect(await liveHeadlines()).toEqual(["Get vaccinated", "EmergencyInfoBC", "Emergency Support Services", "Drought in B.C.\u00a0"]);

    // Same rows the Hub writes: bytes on the slide, plus the content-addressed file.
    const { slides } = await state();
    expect(slides.every((s) => s.image && s.image_type)).toBe(true);
    const expectedFiles = FIXTURE.map((s) => `${createHash("sha256").update(Buffer.from(String(s.image), "base64")).digest("hex")}.${s.imageType === "image/png" ? "png" : "jpg"}`).sort();
    expect(await storedFiles()).toEqual(expectedFiles);
    const tracked = (await tdb.pool.query("SELECT legacy_key FROM public_import_slides p JOIN slides s ON s.id = p.slide_id ORDER BY s.sort_index")).rows.map((r) => r.legacy_key);
    expect(tracked).toEqual(KEYS);

    // One event, the Hub's own snapshot, to the configured subscribers; one system log line.
    const events = await outbox();
    expect(events.map((e) => [e.type, e.aggregate_id, e.envelope.source])).toEqual([["site.content.changed", "site:slides", "nrms"]]);
    expect(events[0]!.envelope.data).toEqual(await tdb.db.transaction((tx) => slidesSnapshot(tx, files)));
    expect(await deliveries()).toEqual(["news-api"]);
    expect(await logs()).toEqual([{ actor_id: "system", area: "carousel", text: IMPORT_LOG_TEXT }]);
  });

  it("emits the same change as a Hub publish of the same slides (only ids and timestamps differ), and nothing that sends mail", async () => {
    await run();
    const imported = (await outbox()).at(-1)!.envelope.data as { slides: Record<string, unknown>[] };

    // The same carousel published through the Hub, from scratch.
    await tdb.pool.query("TRUNCATE carousels, slides, site_log, outbox_events, outbox_deliveries, aggregate_sequences, public_import_carousel, public_import_slides CASCADE");
    const { slides: mapped } = await mapPublicSlides(fixture());
    const t = await dbClock(tdb.db);
    const next = await createNextCarousel(tdb.db, { goLiveAt: new Date(t.getTime() + 60_000).toISOString() }, editor, subs, TZ);
    const saved = await saveCarousel(tdb.db, next.id, { version: next.version, slides: mapped.map((s) => ({ ...s })) }, editor, subs, TZ, files);
    for (let i = 0; i < mapped.length; i++) await setSlideImage(tdb.db, saved.slides[i]!.id, mapped[i]!.image!, editor, subs, files);
    await makeNextLive(tdb.db, editor, subs, files);
    const hubEvents = await outbox();
    const hub = hubEvents.at(-1)!;
    expect(hub.aggregate_id).toBe("site:slides");

    const strip = (d: { slides: Record<string, unknown>[] }) => d.slides.map(({ id: _id, timestamp: _ts, ...rest }) => rest);
    expect(strip(imported)).toEqual(strip(hub.envelope.data as { slides: Record<string, unknown>[] }));
    // Neither path emits anything but site content: no release, media-list or delivery events.
    expect(new Set(hubEvents.map((e) => e.type))).toEqual(new Set(["site.content.changed"]));
  });

  it("is idempotent: a re-run with the same source changes nothing at all", async () => {
    await run();
    const before = { ...(await state()), events: (await outbox()).length, logs: (await logs()).length, files: await storedFiles() };
    const again = await run();
    expect(again.write).toMatchObject({ action: "unchanged" });
    expect(again.failed).toBe(false);
    expect({ ...(await state()), events: (await outbox()).length, logs: (await logs()).length, files: await storedFiles() }).toEqual(before);
  });

  it("a re-run with a changed source updates the imported carousel in place, matched by key", async () => {
    await run();
    const idsBefore = new Map((await tdb.pool.query("SELECT p.legacy_key, s.id FROM public_import_slides p JOIN slides s ON s.id = p.slide_id")).rows.map((r) => [r.legacy_key, r.id]));
    const list = fixture();
    list[1]!.headline = "EmergencyInfoBC (updated)";
    const changed = [list[3]!, list[1]!, list[0]!]; // reordered, slide 2 gone
    const report = await run({}, changed);
    expect(report.write).toMatchObject({ action: "update", changes: { added: [], changed: [KEYS[1]], removed: [KEYS[2]], reordered: true } });
    expect(await liveHeadlines()).toEqual(["Drought in B.C.\u00a0", "EmergencyInfoBC (updated)", "Get vaccinated"]);
    const idsAfter = new Map((await tdb.pool.query("SELECT p.legacy_key, s.id FROM public_import_slides p JOIN slides s ON s.id = p.slide_id")).rows.map((r) => [r.legacy_key, r.id]));
    for (const k of [KEYS[0], KEYS[1], KEYS[3]]) expect(idsAfter.get(k)).toBe(idsBefore.get(k));
    expect(idsAfter.has(KEYS[2])).toBe(false);
    const events = await outbox();
    expect(events).toHaveLength(2);
    expect(events[1]!.envelope.data).toEqual(await tdb.db.transaction((tx) => slidesSnapshot(tx, files)));
  });

  it("replaces a live carousel staff never edited (an SQL-imported one) without --replace", async () => {
    await sqlImportedLive("From the SQL import");
    const report = await run();
    expect(report.write).toMatchObject({ action: "create", replaces: { slides: [{ headline: "From the SQL import", legacyKey: null }] } });
    expect(await liveHeadlines()).toHaveLength(4);
  });

  it("refuses to replace a carousel staff edited, says what would be replaced, and writes nothing; --replace does it", async () => {
    await hubLive(["Test slide"]);
    const before = { ...(await state()), events: (await outbox()).length, logs: (await logs()).length };

    const refused = await run();
    expect(refused.failed).toBe(true);
    expect(refused.write).toMatchObject({ action: "refused", replaces: { state: "live", slides: [{ headline: "Test slide", legacyKey: null }] } });
    expect(refused.write!.reason).toMatch(/--replace/);
    expect(refused.write!.staffEdits.map((e) => e.by)).toContain(editor.name);
    expect({ ...(await state()), events: (await outbox()).length, logs: (await logs()).length }).toEqual(before);
    expect(await storedFiles()).toEqual([]);

    const replaced = await run({ replace: true });
    expect(replaced.failed).toBe(false);
    expect(replaced.write).toMatchObject({ action: "create" });
    expect(await liveHeadlines()).toHaveLength(4);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM carousels WHERE state = 'past'")).rows[0].n).toBe(1);
  });

  it("--remove restores exactly the carousel the import replaced, and the site's slides with it", async () => {
    // Five past carousels (the Hub keeps five) and a live one: a Hub switch-over now would trim
    // the oldest past one, which --remove could then never bring back.
    for (let i = 0; i < 5; i++) await hubLive([`Old carousel ${i}`]);
    await hubLive(["Newer test slide"]);
    const before = await state();
    expect(before.carousels.filter((c) => c.state === "past")).toHaveLength(5);
    const snapshotBefore = await tdb.db.transaction((tx) => slidesSnapshot(tx, files));

    await run({ replace: true });
    expect(await liveHeadlines()).toHaveLength(4);
    const report = await run({ remove: true });
    expect(report.failed).toBe(false);
    expect(report.remove).toMatchObject({ action: "restore", restores: { slides: [{ headline: "Newer test slide" }] } });
    expect(fetches).toBe(1); // --remove fetches nothing

    expect(await state()).toEqual(before);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM public_import_carousel")).rows[0].n).toBe(0);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM public_import_slides")).rows[0].n).toBe(0);
    const last = (await outbox()).at(-1)!;
    expect(last.aggregate_id).toBe("site:slides");
    expect(last.envelope.data).toEqual(snapshotBefore);

    // Nothing left to remove; a second --remove is a no-op.
    expect((await run({ remove: true })).remove).toMatchObject({ action: "nothing" });
  });

  it("--remove with no carousel before the import leaves none (the site shows no slides)", async () => {
    await run();
    const report = await run({ remove: true });
    expect(report.remove).toMatchObject({ action: "restore", restores: null });
    expect((await state()).carousels).toEqual([]);
    expect((await outbox()).at(-1)!.envelope.data).toEqual({ entity: "slides", slides: [] });
  });

  it("after staff edit the imported carousel, a changed re-run and --remove both refuse without --replace", async () => {
    await run();
    const [{ id }] = (await tdb.pool.query("SELECT id, version FROM carousels WHERE state = 'live'")).rows;
    const { version } = (await tdb.pool.query("SELECT version FROM carousels WHERE id = $1", [id])).rows[0];
    const current = (await tdb.pool.query("SELECT id, headline, summary, action_url, action_label, facebook_post_url, justify FROM slides WHERE carousel_id = $1 ORDER BY sort_index", [id])).rows;
    await saveCarousel(
      tdb.db,
      id,
      { version, slides: current.map((s, i) => ({ id: s.id, headline: i === 0 ? "Edited by staff" : s.headline, summary: s.summary, actionUrl: s.action_url, actionLabel: s.action_label, facebookPostUrl: s.facebook_post_url, justify: s.justify })) },
      editor,
      subs,
      TZ,
      files,
    );

    const rerun = await run();
    expect(rerun.write).toMatchObject({ action: "refused", changes: { changed: [KEYS[0]] } });
    expect(await liveHeadlines()).toContain("Edited by staff");
    expect((await run({ remove: true })).remove).toMatchObject({ action: "refused" });
    expect((await run({ remove: true, dryRun: true })).remove).toMatchObject({ action: "refused" });

    expect((await run({ replace: true })).write).toMatchObject({ action: "update" });
    expect(await liveHeadlines()).toContain("Get vaccinated");
    // --replace restarted the clock: no staff edit since, so --remove now goes through.
    expect((await run({ remove: true })).remove).toMatchObject({ action: "restore" });
  });

  it("when staff have published another carousel since, re-import refuses and --remove only deletes the (past) imported one", async () => {
    await run();
    const staffId = await hubLive(["Staff carousel"]);
    expect((await run()).write).toMatchObject({ action: "refused" });
    const eventsBefore = (await outbox()).length;
    const report = await run({ remove: true });
    expect(report.remove).toMatchObject({ action: "drop-past" });
    expect((await state()).carousels.map((c) => [c.id, c.state])).toEqual([[staffId, "live"]]);
    expect((await outbox()).length).toBe(eventsBefore); // nothing public changed
  });

  it("--remove refuses when the carousel it replaced was trimmed (the site would have none), unless --replace", async () => {
    await hubLive(["Test slide"]);
    await run({ replace: true });
    const prev = (await tdb.pool.query("SELECT previous_live_id FROM public_import_carousel")).rows[0].previous_live_id as string;
    await tdb.pool.query("DELETE FROM carousels WHERE id = $1", [prev]); // as a later switch-over's trim would
    const before = { ...(await state()), events: (await outbox()).length };

    const refused = await run({ remove: true });
    expect(refused.failed).toBe(true);
    expect(refused.remove).toMatchObject({ action: "refused" });
    expect(refused.remove!.reason).toMatch(/no longer exists.*no carousel.*--replace/);
    expect({ ...(await state()), events: (await outbox()).length }).toEqual(before);

    const forced = await run({ remove: true, replace: true });
    expect(forced.remove).toMatchObject({ action: "restore", restores: null });
    expect((await state()).carousels).toEqual([]);
  });

  it("--remove rolls back if the carousel to restore can't be made live (the restore must touch exactly one row)", async () => {
    await hubLive(["Test slide"]);
    await run({ replace: true });
    const prev = (await tdb.pool.query("SELECT previous_live_id FROM public_import_carousel")).rows[0].previous_live_id as string;
    await tdb.pool.query("UPDATE carousels SET state = 'next', go_live_at = now() + interval '1 hour' WHERE id = $1", [prev]);
    const before = { ...(await state()), events: (await outbox()).length };
    await expect(run({ remove: true })).rejects.toThrow(/restore/);
    expect({ ...(await state()), events: (await outbox()).length }).toEqual(before);
  });

  it("a staff-scheduled next carousel is not an edit of the live one: import and --remove go ahead", async () => {
    await sqlImportedLive("From the SQL import");
    const t = await dbClock(tdb.db);
    await createNextCarousel(tdb.db, { goLiveAt: new Date(t.getTime() + 3_600_000).toISOString() }, editor, subs, TZ);
    const imported = await run();
    expect(imported.write).toMatchObject({ action: "create", staffEdits: [] });

    // Staff edit the next carousel (a copy of the imported one) after the import.
    const { next } = await import("../website/carousel").then((m) => m.getCarousels(tdb.db));
    await saveCarousel(tdb.db, next!.id, { version: next!.version, slides: [hubSlide("Next week")] }, editor, subs, TZ, files);
    const list = fixture();
    list[0]!.headline = "Get vaccinated (updated)";
    expect((await run({}, list)).write).toMatchObject({ action: "update" });
    expect((await run({ remove: true })).remove).toMatchObject({ action: "restore", staffEdits: [] });
  });

  it("carousel log lines name their carousel; an older line without one still counts, with an accurate message", async () => {
    const id = await hubLive(["Test slide"]);
    const ids = (await tdb.pool.query("SELECT DISTINCT carousel_id FROM site_log WHERE area = 'carousel'")).rows.map((r) => r.carousel_id);
    expect(ids).toEqual([id]);

    await tdb.pool.query("TRUNCATE carousels, slides, site_log CASCADE");
    await sqlImportedLive("From the SQL import");
    await tdb.pool.query("INSERT INTO site_log (actor_id, actor_name, area, text) VALUES ($1, $2, 'carousel', 'Saved the live carousel')", [editor.id, editor.name]);
    const report = await run();
    expect(report.write).toMatchObject({ action: "refused" });
    expect(report.write!.reason).toMatch(/^a carousel was edited in the Hub since the live carousel was created/);
  });

  it("refuses to empty the carousel when the source has nothing importable", async () => {
    await hubLive(["Test slide"]);
    const bad = fixture().map((s) => ({ ...s, image: "***" }));
    const report = await run({ replace: true }, bad);
    expect(report.failed).toBe(true);
    expect(report.source!.refused).toHaveLength(4);
    expect(report.write).toMatchObject({ action: "refused" });
    expect(await liveHeadlines()).toEqual(["Test slide"]);
  });

  it("--dry-run reports what it would do and writes nothing (rows, events, logs or files)", async () => {
    await hubLive(["Test slide"]);
    const before = { ...(await state()), events: (await outbox()).length, logs: (await logs()).length };
    const dry = await run({ dryRun: true, replace: true });
    expect(dry.mode).toBe("dry-run");
    expect(dry.write).toMatchObject({ action: "create", replaces: { slides: [{ headline: "Test slide" }] } });
    expect(dry.source!.slides.map((s) => s.key)).toEqual(KEYS);
    expect({ ...(await state()), events: (await outbox()).length, logs: (await logs()).length }).toEqual(before);
    expect(await storedFiles()).toEqual([]);

    await run({ replace: true });
    const after = { ...(await state()), events: (await outbox()).length };
    expect((await run({ remove: true, dryRun: true })).remove).toMatchObject({ action: "restore", restores: { slides: [{ headline: "Test slide" }] } });
    expect({ ...(await state()), events: (await outbox()).length }).toEqual(after);

    // Without a database: the source only.
    const noDb = await run({ dryRun: true }, fixture(), false);
    expect(noDb.write).toBeUndefined();
    expect(noDb.source!.slides).toHaveLength(4);
  });
});
