import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
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
