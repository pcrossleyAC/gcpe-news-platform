import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { categoryFeatures } from "../db/schema";
import { createNrmsTestDb, createScheduledRelease } from "../../test/helpers";
import { createApp } from "../app";
import { bcSettings, prePlan4Settings } from "../../../../packages/site-settings/src/fixtures";

const SECRET = "z".repeat(40) + "-nrms-site-session-test";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);

describe("NRMS site HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let slideFilesRoot: string;
  let siteEditorCookie: string;
  let editorOnlyCookie: string;
  let viewerCookie: string;

  const cookieFor = async (roles: string[], name = "Pat Example") =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000b", name, email: "pat@example.invalid", roles })).token}`;
  const get = (path: string, cookie: string) => request(app).get(path).set("cookie", cookie);
  const post = (path: string, cookie: string, body: unknown) => request(app).post(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const put = (path: string, cookie: string, body: unknown) => request(app).put(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);

  const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString();

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    slideFilesRoot = await mkdtemp(join(tmpdir(), "nrms-site-routes-slides-"));
    const slideFiles = { store: localStore(slideFilesRoot, "/files/"), filesBase: "" };
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, subscribers: [], slideFiles });
    siteEditorCookie = await cookieFor(["NRMS.SiteEditor"], "Sam SiteEditor");
    editorOnlyCookie = await cookieFor(["NRMS.Editor"]);
    viewerCookie = await cookieFor(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(slideFilesRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE carousels, slides, emergency_pins, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });

  it("a site editor can create and save the next carousel", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: "next", slides: [] });

    const saved = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: created.body.version,
      slides: [{ headline: "H1", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.slides).toHaveLength(1);
    expect(saved.body.slides[0]).toMatchObject({ headline: "H1", hasImage: false, imageUrl: null });
  });

  it("saving a slide and a pin round-trips actionLabel; an older writer that omits it is accepted; a bad label is a 422", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    const saved = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: created.body.version,
      slides: [
        { headline: "H1", summary: "", actionUrl: "", actionLabel: " Read it ", facebookPostUrl: "", justify: "left" },
        { headline: "H2", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.slides.map((s: { actionLabel: string }) => s.actionLabel)).toEqual(["Read it", ""]);
    const bad = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: saved.body.version,
      slides: [{ headline: "H1", summary: "", actionUrl: "", actionLabel: "<b>x</b>", facebookPostUrl: "", justify: "left" }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual(["Keep the action label to 40 characters or fewer, in plain text."]);
  });

  it("a PUT that omits actionLabel keeps the stored label (slide by id, and pin); schema trims; too long is the 422 message", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    const base = { headline: "H1", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" };
    const saved = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, { version: created.body.version, slides: [{ ...base, actionLabel: "Read it" }] });
    expect(saved.body.slides[0].actionLabel).toBe("Read it");
    const again = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, { version: saved.body.version, slides: [{ ...base, id: saved.body.slides[0].id, headline: "H1b" }] });
    expect(again.status).toBe(200);
    expect(again.body.slides[0]).toMatchObject({ headline: "H1b", actionLabel: "Read it" });
    const cleared = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, { version: again.body.version, slides: [{ ...base, id: saved.body.slides[0].id, actionLabel: "   " }] });
    expect(cleared.body.slides[0].actionLabel).toBe("");
    const tooLong = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, { version: cleared.body.version, slides: [{ ...base, actionLabel: "x".repeat(41) }] });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.errors).toEqual(["Keep the action label to 40 characters or fewer, in plain text."]);

    await tdb.pool.query("INSERT INTO emergency_pins (slot) VALUES ('primary'), ('secondary')");
    const pinBody = { version: 1, headline: "Alert", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" };
    const pin1 = await put("/api/site/pins/primary", siteEditorCookie, { ...pinBody, actionLabel: "Get help" });
    expect(pin1.status).toBe(200);
    const pin2 = await put("/api/site/pins/primary", siteEditorCookie, { ...pinBody, version: pin1.body.version, headline: "Alert 2" });
    expect(pin2.status).toBe(200);
    expect(pin2.body.slide).toMatchObject({ headline: "Alert 2", actionLabel: "Get help" });
  });

  // Fix round 1 (controller ruling): goLiveAt/goLiveAtLocal is an XOR for creating the next
  // carousel (exactly one required) — both or neither is a 400, same shape as scheduleSchema's
  // publishAt/publishAtLocal.
  it("POST /site/carousels/next: goLiveAtLocal converts server-side; neither or both goLiveAt/goLiveAtLocal is a 400", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAtLocal: "2026-12-15T14:30" });
    expect(created.status).toBe(201);
    expect(created.body.goLiveAt).toBe("2026-12-15T21:30:00.000Z"); // 14:30 UTC-7 (permanent BC time) -> 21:30Z

    const neither = await post("/api/site/carousels/next", siteEditorCookie, {});
    expect(neither.status).toBe(400);

    const both = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future(), goLiveAtLocal: "2030-01-01T00:00" });
    expect(both.status).toBe(400);

    await request(app).delete(`/api/site/carousels/next?version=${created.body.version}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
  });

  it("POST /site/carousels/next: an invalid calendar date/time in goLiveAtLocal is a 400", async () => {
    const res = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAtLocal: "2026-02-30T10:00" });
    expect(res.status).toBe(400);
  });

  it("PUT /site/carousels/:id: goLiveAtLocal converts server-side; both goLiveAt and goLiveAtLocal is a 400", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    const both = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: created.body.version,
      goLiveAt: future(),
      goLiveAtLocal: "2030-01-01T00:00",
      slides: [],
    });
    expect(both.status).toBe(400);

    const saved = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, { version: created.body.version, goLiveAtLocal: "2030-06-15T10:30", slides: [] });
    expect(saved.status).toBe(200);
    expect(saved.body.goLiveAt).toBe("2030-06-15T17:30:00.000Z"); // 10:30 PDT (UTC-7) -> 17:30Z

    await request(app).delete(`/api/site/carousels/next?version=${saved.body.version}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
  });

  it("an NRMS.Editor-only user gets 403 on PUT /site/carousels/:id; a viewer can read but not write", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    expect(created.status).toBe(201);

    const deniedEditor = await put(`/api/site/carousels/${created.body.id}`, editorOnlyCookie, { version: created.body.version, slides: [] });
    expect(deniedEditor.status).toBe(403);

    const read = await get("/api/site/carousels", viewerCookie);
    expect(read.status).toBe(200);
    expect(read.body.next.id).toBe(created.body.id);

    const deniedViewer = await put(`/api/site/carousels/${created.body.id}`, viewerCookie, { version: created.body.version, slides: [] });
    expect(deniedViewer.status).toBe(403);

    await request(app).delete(`/api/site/carousels/next?version=${created.body.version}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
  });

  it("a 3 MiB slide image is refused with 413", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    const saved = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: created.body.version,
      slides: [{ headline: "H1", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" }],
    });
    const slideId = saved.body.slides[0].id;
    const tooBig = Buffer.alloc(3 * 1024 * 1024, 1);
    const res = await request(app)
      .put(`/api/site/slides/${slideId}/image`)
      .set("cookie", siteEditorCookie)
      .set("x-gcpe-request", "1")
      .set("content-type", "image/png")
      .send(tooBig);
    expect(res.status).toBe(413);

    await request(app).delete(`/api/site/carousels/next?version=${saved.body.version}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
  });

  it("GET /site/slides/:id/image returns the stored content type", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    const saved = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: created.body.version,
      slides: [{ headline: "H1", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" }],
    });
    const slideId = saved.body.slides[0].id;
    const uploaded = await request(app)
      .put(`/api/site/slides/${slideId}/image`)
      .set("cookie", siteEditorCookie)
      .set("x-gcpe-request", "1")
      .set("content-type", "image/png")
      .send(PNG);
    expect(uploaded.status).toBe(204);

    const image = await request(app).get(`/api/site/slides/${slideId}/image`).set("cookie", siteEditorCookie);
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toMatch(/^image\/png/);
    expect(image.headers["cache-control"]).toBe("private, max-age=300");

    await request(app).delete(`/api/site/carousels/next?version=${saved.body.version}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
  });

  it("audit #9: POST /site/slide-images stages an image (201, upload name), refuses over 2 MB (413), a non-image (422) and a viewer (403); the carousel PUT sets it", async () => {
    const stage = (body: Buffer, cookie = siteEditorCookie) =>
      request(app).post("/api/site/slide-images").set("cookie", cookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream").send(body);
    expect((await stage(Buffer.alloc(3 * 1024 * 1024, 1))).status).toBe(413);
    const html = await stage(Buffer.from("<html></html>"));
    expect(html.status).toBe(422);
    expect(html.body.errors).toEqual(["Upload a JPEG or PNG image."]);
    expect((await stage(PNG, viewerCookie)).status).toBe(403);
    expect((await stage(PNG, editorOnlyCookie)).status).toBe(403);
    const badTarget = await request(app).post("/api/site/slide-images?carouselId=nope&slide=1").set("cookie", siteEditorCookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream").send(PNG);
    expect(badTarget.status).toBe(400);
    const staged = await stage(PNG);
    expect(staged.status).toBe(201);
    expect(staged.body.upload).toMatch(/^[0-9a-f]{64}\.png$/);

    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    const bad = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: created.body.version,
      slides: [{ headline: "H1", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left", imageUpload: "../secret.png" }],
    });
    expect(bad.status).toBe(400);
    const saved = await put(`/api/site/carousels/${created.body.id}`, siteEditorCookie, {
      version: created.body.version,
      slides: [{ headline: "H1", summary: "", actionUrl: "", facebookPostUrl: "", justify: "left", imageUpload: staged.body.upload }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.slides[0]).toMatchObject({ headline: "H1", hasImage: true });
    await request(app).delete(`/api/site/carousels/next?version=${saved.body.version}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
  });

  it("a cookie-authenticated write without x-gcpe-request is refused with 403", async () => {
    const res = await request(app).post("/api/site/carousels/next").set("cookie", siteEditorCookie).send({ goLiveAt: future() });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "missing X-GCPE-Request header" });
  });

  it("PUT /site/blue-bridge: NRMS.SiteEditor gets 403; Core.Admin with the phrase gets 200 and GET carries the IGRS warning", async () => {
    const coreAdminCookie = await cookieFor(["Core.Admin"], "Avery Admin");

    const before = await get("/api/site/blue-bridge", coreAdminCookie);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ on: false, warning: "Do not click OK unless you have approval from IGRS" });

    const denied = await put("/api/site/blue-bridge", siteEditorCookie, {
      version: before.body.version,
      on: true,
      confirmation: "KING CHARLES III",
      acknowledgeIgrs: true,
    });
    expect(denied.status).toBe(403);

    const refused = await put("/api/site/blue-bridge", coreAdminCookie, {
      version: before.body.version,
      on: true,
      confirmation: "wrong",
      acknowledgeIgrs: true,
    });
    expect(refused.status).toBe(422);

    const saved = await put("/api/site/blue-bridge", coreAdminCookie, {
      version: before.body.version,
      on: true,
      confirmation: "KING CHARLES III",
      acknowledgeIgrs: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ on: true, version: before.body.version + 1 });

    await put("/api/site/blue-bridge", coreAdminCookie, { version: saved.body.version, on: false, confirmation: "KING CHARLES III", acknowledgeIgrs: true });
  });

  it("GET /site/log lists the actor's display name, newest first", async () => {
    const created = await post("/api/site/carousels/next", siteEditorCookie, { goLiveAt: future() });
    expect(created.status).toBe(201);

    const log = await get("/api/site/log?area=carousel", siteEditorCookie);
    expect(log.status).toBe(200);
    expect(Array.isArray(log.body)).toBe(true);
    expect(log.body[0]).toMatchObject({ actorName: "Sam SiteEditor", area: "carousel" });
    expect(typeof log.body[0].at).toBe("string");

    await request(app).delete(`/api/site/carousels/next?version=${created.body.version}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
  });
});

const PDF = Buffer.from("%PDF-1.7\n% test\n");

describe("NRMS site HTTP API — Live Feed, links and files", () => {
  let tdb: TestDatabase;
  let root: string;
  let store: ObjectStore;
  let app: ReturnType<typeof createApp>;
  let siteEditorCookie: string;
  let viewerCookie: string;

  const cookieFor = async (roles: string[], name = "Sam SiteEditor") =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name, email: "sam@example.invalid", roles })).token}`;
  const get = (path: string, cookie: string) => request(app).get(path).set("cookie", cookie);
  const put = (path: string, cookie: string, body: unknown) => request(app).put(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const upload = (path: string, cookie: string, bytes: Buffer, name?: string) => {
    const r = request(app).post(path).set("cookie", cookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream");
    return (name === undefined ? r : r.set("x-gcpe-file-name", encodeURIComponent(name))).send(bytes);
  };

  const defaults = { manifestUrl: "https://default.invalid/manifest.f4m", m3uUrl: "https://default.invalid/playlist.m3u8" };

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    root = await mkdtemp(join(tmpdir(), "nrms-site-files-routes-"));
    store = localStore(root, "/files/");
    app = createApp({
      db: tdb.db,
      auth: { session: { secret: SECRET } },
      eventSecrets: {},
      workflow: { timeZone: "America/Vancouver" },
      subscribers: [],
      store,
      slideFiles: { store, filesBase: "" },
      liveFeedDefaults: defaults,
    });
    siteEditorCookie = await cookieFor(["NRMS.SiteEditor"]);
    viewerCookie = await cookieFor(["NRMS.Viewer"], "Val Viewer");
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, category_features, resource_links, site_files, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
    await tdb.pool.query(
      "UPDATE site_settings SET live_feed_enabled = false, live_manifest_url = '', live_m3u_url = '', links_version = 1, version = 1, updated_at = now() WHERE id = 1",
    );
  });

  it("GET /site/live-feed shows the environment default when unset; a site editor can turn it on", async () => {
    const before = await get("/api/site/live-feed", siteEditorCookie);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ enabled: false, manifestUrl: defaults.manifestUrl, m3uUrl: defaults.m3uUrl, version: 1 });

    const refused = await put("/api/site/live-feed", siteEditorCookie, { version: 1, enabled: true, manifestUrl: "", m3uUrl: "" });
    expect(refused.status).toBe(422);

    const saved = await put("/api/site/live-feed", siteEditorCookie, {
      version: 1,
      enabled: true,
      manifestUrl: "https://live.invalid/m.f4m",
      m3uUrl: "https://live.invalid/p.m3u8",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, version: 2 });

    const deniedViewer = await put("/api/site/live-feed", viewerCookie, { version: 2, enabled: false, manifestUrl: "", m3uUrl: "" });
    expect(deniedViewer.status).toBe(403);
  });

  it("GET/PUT /site/links: a site editor saves links; a stale version is 409; a viewer can read but not write", async () => {
    const empty = await get("/api/site/links", siteEditorCookie);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ version: 1, links: [] });

    const saved = await put("/api/site/links", siteEditorCookie, { version: 1, links: [{ text: "A", url: "https://a.invalid" }] });
    expect(saved.status).toBe(200);
    expect(saved.body.links).toHaveLength(1);
    expect(saved.body.version).toBe(2);

    const stale = await put("/api/site/links", siteEditorCookie, { version: 1, links: [] });
    expect(stale.status).toBe(409);

    const read = await get("/api/site/links", viewerCookie);
    expect(read.status).toBe(200);
    expect(read.body.links).toHaveLength(1);

    const deniedViewer = await put("/api/site/links", viewerCookie, { version: saved.body.version, links: [] });
    expect(deniedViewer.status).toBe(403);
  });

  it("a site editor uploads a PDF: 201, served at /files/<name>, readable from the store; a viewer gets 403", async () => {
    const res = await upload("/api/site/files", siteEditorCookie, PDF, "Budget 2026.pdf");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "budget-2026.pdf", url: "/files/budget-2026.pdf", contentType: "application/pdf" });
    const stored = await store.get("budget-2026.pdf");
    expect(stored!.bytes.equals(PDF)).toBe(true);

    const denied = await upload("/api/site/files", viewerCookie, PDF, "other.pdf");
    expect(denied.status).toBe(403);

    const list = await get("/api/site/files", siteEditorCookie);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);

    const del = await request(app).delete(`/api/site/files/${res.body.id}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
    expect(del.status).toBe(204);
    expect(await store.get("budget-2026.pdf")).toBeNull();
  });

  it("a 26 MiB upload is accepted now (any type, up to 512 MiB, streamed to the store)", async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);
    const res = await upload("/api/site/files", siteEditorCookie, big, "big.pdf");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "big.pdf", size: big.length });
    expect((await store.get("big.pdf"))!.bytes.length).toBe(big.length);
  });

  it("any type is accepted (an HTML file is stored as octet-stream, never text/html)", async () => {
    const res = await upload("/api/site/files", siteEditorCookie, Buffer.from("<script>alert(1)</script>"), "Evil Page.html");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "evil-page.html", url: "/files/evil-page.html", contentType: "application/octet-stream" });
  });

  it("over the site-file cap is a 413 (declared length or streamed body) and nothing is stored, not even a temp file", async () => {
    const capped = createApp({
      db: tdb.db,
      auth: { session: { secret: SECRET } },
      eventSecrets: {},
      workflow: { timeZone: "America/Vancouver" },
      subscribers: [],
      store,
      slideFiles: { store, filesBase: "" },
      liveFeedDefaults: defaults,
      maxSiteFileBytes: 64,
    });
    const server = capped.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const res = await request(server).post("/api/site/files").set("cookie", siteEditorCookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream").set("x-gcpe-file-name", "over.pdf").send(Buffer.concat([PDF, Buffer.alloc(100)]));
    expect(res.status).toBe(413);
    // Chunked (no Content-Length): refused while streaming.
    const chunked = request(server).post("/api/site/files").set("cookie", siteEditorCookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream").set("x-gcpe-file-name", "over2.pdf");
    chunked.write(PDF);
    chunked.write(Buffer.alloc(100));
    const res2 = await chunked;
    expect(res2.status).toBe(413);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await store.get("over.pdf")).toBeNull();
    expect(await store.get("over2.pdf")).toBeNull();
    expect((await readdir(root)).filter((n) => n.startsWith("tmp-"))).toEqual([]);
  });

  it("site files: the name comes only from X-GCPE-File-Name; ?name= is refused and nothing is stored", async () => {
    const viaQuery = await upload("/api/site/files?name=sample.pdf&replace=false", siteEditorCookie, PDF);
    const both = await upload("/api/site/files?name=sample.pdf", siteEditorCookie, PDF, "sample.pdf");
    const missing = await upload("/api/site/files?replace=false", siteEditorCookie, PDF);
    for (const res of [viaQuery, both, missing]) expect(res.status).toBe(400);
    expect(missing.body.issues).toEqual([expect.objectContaining({ path: ["name"], message: "Name the file." })]);
    expect(await store.get("sample.pdf")).toBeNull();
  });

  it.each([["NUL", "\u0000", "00"], ["\\x01", "\u0001", "01"], ["\\x7f", "\u007f", "7f"], ["newline", "\n", "0a"]])(
    "a %s in a site file's name is sanitised into the stored key, not passed through raw",
    async (_label, ctrl, tag) => {
      // Each case needs its own final key — site file names are unique, and every one of these
      // control characters sanitises down to the same "-".
      const res = await upload("/api/site/files", siteEditorCookie, PDF, `evil${ctrl}name-${tag}.pdf`);
      expect(res.status).toBe(201);
      expect(res.body.name).toBe(`evil-name-${tag}.pdf`);
      expect(res.body.name).not.toContain(ctrl);
      expect(await store.get(`evil-name-${tag}.pdf`)).not.toBeNull();
    },
  );

  it("GET /site/features lists what's featured where; a viewer can read it", async () => {
    const top = await createScheduledRelease(tdb.db, { headline: "Featured headline" });
    await tdb.db.insert(categoryFeatures).values({ kind: "home", key: "default", topReleaseId: top.id });

    const res = await get("/api/site/features", viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { kind: "home", key: "default", label: "Home", top: { id: top.id, key: top.key, headline: "Featured headline" }, feature: null },
    ]);
  });
});

describe("NRMS site settings HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let siteEditor: string;
  let admin: string;
  let editorOnly: string;
  let viewer: string;
  const defaults = bcSettings();
  const S = "/api/site/settings";

  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name: "Sam SiteEditor", email: "sam@example.invalid", roles })).token}`;
  const w = (method: "put" | "post" | "delete", path: string, cookie: string, body?: unknown) =>
    request(app)[method](path).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const publish = (cookie: string, body: object) => w("post", `${S}/publish`, cookie, body);
  const banner = (message: string) => ({ ...defaults.banner, message });

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    app = createApp({
      db: tdb.db,
      auth: { session: { secret: SECRET } },
      eventSecrets: {},
      workflow: { timeZone: "America/Vancouver" },
      subscribers: [],
      siteSettingsDefaults: defaults,
    });
    siteEditor = await cookieFor(["NRMS.SiteEditor"]);
    admin = await cookieFor(["Core.Admin"]);
    editorOnly = await cookieFor(["NRMS.Editor"]);
    viewer = await cookieFor(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE site_settings_revisions, site_settings_drafts, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });

  it("GET / returns the defaults before anything is published; NRMS.Editor, Viewer and anonymous are refused", async () => {
    const res = await request(app).get(`${S}/`).set("cookie", siteEditor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ live: null, draft: null, baseRevision: null, document: defaults });
    expect((await request(app).get(`${S}/`).set("cookie", admin)).status).toBe(200);
    for (const c of [editorOnly, viewer]) expect((await request(app).get(`${S}/`).set("cookie", c)).status).toBe(403);
    expect((await request(app).get(`${S}/`)).status).toBe(401);
  });

  it("GET /defaults returns the tenant defaults to NRMS.SiteEditor and Core.Admin, and refuses the rest", async () => {
    await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("Live now") });
    for (const c of [siteEditor, admin]) {
      const res = await request(app).get(`${S}/defaults`).set("cookie", c);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(defaults);
    }
    for (const c of [editorOnly, viewer]) expect((await request(app).get(`${S}/defaults`).set("cookie", c)).status).toBe(403);
    expect((await request(app).get(`${S}/defaults`)).status).toBe(401);
  });

  it("PUT /draft with section 'pageText' saves a draft over a pre-plan-4 live revision, which reads back filled; an incomplete section is a 400", async () => {
    await tdb.pool.query("INSERT INTO site_settings_revisions (revision, document, published_by_id, published_by_name) VALUES (1, $1, 'u', 'Jane')", [
      JSON.stringify(prePlan4Settings()),
    ]);
    const pageText = { ...defaults.pageText, notFound: { heading: "Not here.", text: "" } };
    const res = await w("put", `${S}/draft`, siteEditor, { baseRevision: 1, section: "pageText", value: pageText });
    expect(res.status).toBe(200);
    expect(res.body.document).toEqual({ ...defaults, pageText });
    expect(res.body.errors).toEqual([]);
    expect((await w("put", `${S}/draft`, siteEditor, { baseRevision: 1, section: "navigation", value: { newsLabel: "News" } })).status).toBe(400);
    const history = await request(app).get(`${S}/history/1`).set("cookie", siteEditor);
    expect(history.body.document).toEqual(defaults);
    expect(history.body.differing).toEqual([]);
  });

  it("NRMS.Editor gets 403 on every write; Core.Admin reads but gets 403 on publish and every other write", async () => {
    const body = { baseRevision: null, section: "banner", value: banner("x") };
    for (const c of [editorOnly, admin]) {
      expect((await w("put", `${S}/draft`, c, body)).status).toBe(403);
      expect((await publish(c, body)).status).toBe(403);
      expect((await w("delete", `${S}/draft`, c)).status).toBe(403);
      expect((await w("post", `${S}/rebase`, c, { section: "banner", value: banner("x") })).status).toBe(403);
      expect((await w("post", `${S}/restore`, c, { revision: 1, baseRevision: null })).status).toBe(403);
    }
    for (const path of ["/history", "/history/1"]) {
      expect((await request(app).get(`${S}${path}`).set("cookie", admin)).status).not.toBe(403);
      expect((await request(app).get(`${S}${path}`).set("cookie", editorOnly)).status).toBe(403);
    }
  });

  it("PUT /draft saves, GET shows the draft; DELETE /draft discards it (204)", async () => {
    const saved = await w("put", `${S}/draft`, siteEditor, { baseRevision: null, section: "banner", value: banner("Draft text") });
    expect(saved.status).toBe(200);
    expect(saved.body.document.banner.message).toBe("Draft text");
    expect(saved.body.draft).toMatchObject({ baseRevision: null });
    expect((await w("delete", `${S}/draft`, siteEditor)).status).toBe(204);
    expect((await request(app).get(`${S}/`).set("cookie", siteEditor)).body.draft).toBeNull();
  });

  it("a structurally invalid value is a 400", async () => {
    const res = await w("put", `${S}/draft`, siteEditor, { baseRevision: null, section: "banner", value: { enabled: "yes" } });
    expect(res.status).toBe(400);
    expect((await w("put", `${S}/draft`, siteEditor, { baseRevision: null, section: "nope", value: {} })).status).toBe(400);
  });

  it("POST /publish publishes (200 with revision and state) and logs under area settings", async () => {
    const res = await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("Hello"), note: "first" });
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(1);
    expect(res.body.state).toMatchObject({ live: { revision: 1, note: "first" }, draft: null, baseRevision: 1 });
    const log = await request(app).get("/api/site/log?area=settings").set("cookie", siteEditor);
    expect(log.status).toBe(200);
    expect(log.body).toEqual([expect.objectContaining({ area: "settings", text: "Published revision 1: first" })]);
  });

  it("W4: POST /publish with onlySection publishes just that section and keeps the rest of the draft; a non-boolean is a 400", async () => {
    await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("Live") });
    await w("put", `${S}/draft`, siteEditor, { baseRevision: 1, section: "footer", value: { ...defaults.footer, copyrightHolder: "Draft holder" } });
    const res = await publish(siteEditor, { baseRevision: 1, section: "banner", value: banner("Urgent"), onlySection: true });
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(2);
    expect(res.body.state).toMatchObject({ live: { revision: 2 }, draft: { baseRevision: 2 }, draftSections: ["footer"] });
    expect((await request(app).get(`${S}/history/2`).set("cookie", siteEditor)).body.document.footer.copyrightHolder).toBe(defaults.footer.copyrightHolder);
    expect((await publish(siteEditor, { baseRevision: 2, section: "banner", value: banner("x"), onlySection: "yes" })).status).toBe(400);
  });

  it("an http link is a 422 with errors and fieldErrors, and nothing is published", async () => {
    const value = { ...defaults.banner, enabled: true, message: "Hi", links: [{ text: "Bad", url: "http://example.com" }] };
    const res = await publish(siteEditor, { baseRevision: null, section: "banner", value });
    expect(res.status).toBe(422);
    expect(res.body.fieldErrors.length).toBeGreaterThan(0);
    expect(res.body.errors).toHaveLength(res.body.fieldErrors.length);
    expect(res.body.errors[0]).toBe(`${res.body.fieldErrors[0].field}: ${res.body.fieldErrors[0].message}`);
    expect((await request(app).get(`${S}/history`).set("cookie", siteEditor)).body.live).toBeNull();
  });

  it("a stale base revision is a 409 with the live info and the differing sections", async () => {
    await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("One") });
    const res = await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("Two") });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "published", code: "published", live: { revision: 1 }, differing: ["banner"] });
  });

  it("a non-null base revision with nothing live is a 409 (live null, no differing sections), not a 500", async () => {
    const pub = await publish(siteEditor, { baseRevision: 3, section: "banner", value: banner("Two") });
    expect(pub.status).toBe(409);
    expect(pub.body).toEqual({ error: "published", code: "published", live: null, differing: [] });
    // Restore can't reach the nothing-live conflict (a revision to restore means something is live): it is a plain 404.
    const restore = await w("post", `${S}/restore`, siteEditor, { revision: 1, baseRevision: 3 });
    expect(restore.status).toBe(404);
  });

  it("banner startsAtLocal/endsAtLocal are converted with the workflow time zone", async () => {
    const value = { ...defaults.banner, startsAtLocal: "2026-03-01T09:00", endsAtLocal: "2026-11-02T09:00" };
    delete (value as Record<string, unknown>).startsAt;
    delete (value as Record<string, unknown>).endsAt;
    const res = await publish(siteEditor, { baseRevision: null, section: "banner", value });
    expect(res.status).toBe(200);
    expect(res.body.state.document.banner).toMatchObject({ startsAt: "2026-03-01T17:00:00.000Z", endsAt: "2026-11-02T16:00:00.000Z" });
    const bad = await w("put", `${S}/draft`, siteEditor, { baseRevision: 1, section: "banner", value: { ...value, startsAtLocal: "2026-02-30T10:00" } });
    expect(bad.status).toBe(400);
    const cleared = await w("put", `${S}/draft`, siteEditor, { baseRevision: 1, section: "banner", value: { ...value, startsAtLocal: null, endsAtLocal: null } });
    expect(cleared.body.document.banner).toMatchObject({ startsAt: null, endsAt: null });
  });

  it("POST /rebase puts my section on top of live and names my other changes they also changed", async () => {
    await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("One") });
    const res = await w("post", `${S}/rebase`, siteEditor, { section: "banner", value: banner("Mine") });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ baseRevision: 1, alsoChangedByThem: [] });
    // N3: for one release, old open Hub tabs still find setAside (now always empty).
    expect(res.body.setAside).toEqual([]);
    expect(res.body.document.banner.message).toBe("Mine");
  });

  it("history lists revisions, shows one with its differences, and 404s an unknown or malformed revision", async () => {
    await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("One") });
    await publish(siteEditor, { baseRevision: 1, section: "banner", value: banner("Two") });
    const list = await request(app).get(`${S}/history`).set("cookie", siteEditor);
    expect(list.body.live).toBe(2);
    expect(list.body.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
    const one = await request(app).get(`${S}/history/1`).set("cookie", siteEditor);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ info: { revision: 1 }, differing: ["banner"] });
    expect(one.body.document.banner.message).toBe("One");
    expect((await request(app).get(`${S}/history/99`).set("cookie", siteEditor)).status).toBe(404);
    expect((await request(app).get(`${S}/history/abc`).set("cookie", siteEditor)).status).toBe(404);
  });

  it("POST /restore republishes an old revision; a stale base is a 409; an unknown revision is a 404", async () => {
    await publish(siteEditor, { baseRevision: null, section: "banner", value: banner("One") });
    await publish(siteEditor, { baseRevision: 1, section: "banner", value: banner("Two") });
    const stale = await w("post", `${S}/restore`, siteEditor, { revision: 1, baseRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "published", live: { revision: 2 } });
    expect((await w("post", `${S}/restore`, siteEditor, { revision: 99, baseRevision: 2 })).status).toBe(404);
    const ok = await w("post", `${S}/restore`, siteEditor, { revision: 1, baseRevision: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ revision: 3 });
    const live = await request(app).get(`${S}/`).set("cookie", siteEditor);
    expect(live.body.document.banner.message).toBe("One");
    expect(live.body.live.note).toBe("Restored revision 1");
  });

  it("answers 503 when the site settings defaults aren't configured", async () => {
    const bare = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, subscribers: [] });
    expect((await request(bare).get(`${S}/`).set("cookie", siteEditor)).status).toBe(503);
    // A revision can't be shown unfilled (a pre-plan-4 one would report every later part as changed).
    expect((await request(bare).get(`${S}/history/1`).set("cookie", siteEditor)).status).toBe(503);
  });
});

describe("GET /site/internal-links: the Hub address check (suite fix W2)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name: "Pat Example", email: "pat@example.invalid", roles })).token}`;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    app = createApp({
      db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver", filesBase: "https://news.example" },
      subscribers: [], siteUrl: "https://news.example", publicSiteUrl: "https://test-news.example", internalHosts: ["hub.example", "news.example", "test-news.example"],
    });
    await tdb.pool.query(
      "INSERT INTO resource_links (sort_index, text, url) VALUES (0, 'Alias', 'https://hub.example/files/a.pdf'), (1, 'Page host', 'https://gcpe-app01.internal/files/b.pdf'), (2, 'Public', 'https://news.example/files/c.pdf'), (3, 'This deployment', 'https://test-news.example/x')",
    );
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("lists stored addresses on a configured internal host or the host the Hub was opened on, never the public site's", async () => {
    const res = await request(app).get("/api/site/internal-links").set("host", "gcpe-app01.internal").set("cookie", await cookieFor(["NRMS.SiteEditor"]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      links: [
        { screen: "links", where: "Link 1 URL", address: "https://hub.example/files/a.pdf" },
        { screen: "links", where: "Link 2 URL", address: "https://gcpe-app01.internal/files/b.pdf" },
      ],
    });
  });

  it("is for Website editors and Core administrators only", async () => {
    expect((await request(app).get("/api/site/internal-links").set("cookie", await cookieFor(["Core.Admin"]))).status).toBe(200);
    expect((await request(app).get("/api/site/internal-links").set("cookie", await cookieFor(["NRMS.Editor"]))).status).toBe(403);
    expect((await request(app).get("/api/site/internal-links").set("cookie", await cookieFor(["NRMS.Viewer"]))).status).toBe(403);
    expect((await request(app).get("/api/site/internal-links")).status).toBe(401);
  });
});
