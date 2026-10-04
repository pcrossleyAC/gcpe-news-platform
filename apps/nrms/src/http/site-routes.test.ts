import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { createNrmsTestDb } from "../../test/helpers";
import { createApp } from "../app";

const SECRET = "z".repeat(40) + "-nrms-site-session-test";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);

describe("NRMS site HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
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
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, subscribers: [] });
    siteEditorCookie = await cookieFor(["NRMS.SiteEditor"], "Sam SiteEditor");
    editorOnlyCookie = await cookieFor(["NRMS.Editor"]);
    viewerCookie = await cookieFor(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
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
  const upload = (path: string, cookie: string, bytes: Buffer) =>
    request(app).post(path).set("cookie", cookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream").send(bytes);

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
    await tdb.pool.query("TRUNCATE resource_links, site_files, site_log, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
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
    const res = await upload("/api/site/files?name=Budget%202026.pdf", siteEditorCookie, PDF);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "budget-2026.pdf", url: "/files/budget-2026.pdf", contentType: "application/pdf" });
    const stored = await store.get("budget-2026.pdf");
    expect(stored!.bytes.equals(PDF)).toBe(true);

    const denied = await upload("/api/site/files?name=other.pdf", viewerCookie, PDF);
    expect(denied.status).toBe(403);

    const list = await get("/api/site/files", siteEditorCookie);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);

    const del = await request(app).delete(`/api/site/files/${res.body.id}`).set("cookie", siteEditorCookie).set("x-gcpe-request", "1");
    expect(del.status).toBe(204);
    expect(await store.get("budget-2026.pdf")).toBeNull();
  });

  it("a 26 MiB upload is refused with 413 and nothing is stored", async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);
    const res = await upload("/api/site/files?name=big.pdf", siteEditorCookie, big);
    expect(res.status).toBe(413);
    expect(await store.get("big.pdf")).toBeNull();
  });
});
