import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { FlickrError, type FlickrClient } from "../media/flickr-client";

const SECRET = "z".repeat(40) + "-nrms-media-test";
const PDF = Buffer.from("%PDF-1.7\n% test\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);

describe("NRMS media routes", () => {
  let tdb: TestDatabase;
  let root: string;
  let store: ObjectStore;
  let app: ReturnType<typeof createApp>;
  let editorCookie: string;
  let viewerCookie: string;
  let siteEditorCookie: string;

  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000a", name: "Pat Editor", email: "pat@example.invalid", roles })).token}`;
  const upload = (path: string, cookie: string, bytes: Buffer) =>
    request(app).post(path).set("cookie", cookie).set("x-gcpe-request", "1").set("content-type", "application/octet-stream").send(bytes);
  const create = async () => {
    const res = await request(app).post("/api/releases").set("cookie", editorCookie).set("x-gcpe-request", "1").send(sampleCreate);
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  };
  const filesPath = (id: string, version: number, name: string, kind = "translation") =>
    `/api/releases/${id}/files?kind=${kind}&version=${version}&name=${encodeURIComponent(name)}`;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    root = await mkdtemp(join(tmpdir(), "nrms-media-routes-"));
    store = localStore(root, "/files/");
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, store });
    editorCookie = await cookieFor(["NRMS.Editor"]);
    viewerCookie = await cookieFor(["NRMS.Viewer"]);
    siteEditorCookie = await cookieFor(["NRMS.SiteEditor"]);
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(root, { recursive: true, force: true });
  });

  it("an editor uploads a PDF translation: 201 with the view listing the file", async () => {
    const { id, version } = await create();
    const res = await upload(filesPath(id, version, "Budget FR.pdf"), editorCookie, PDF);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id, version: version + 1, hasTranslations: true, statusText: "Draft" });
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0]).toMatchObject({ kind: "translation", label: "Budget FR.pdf", contentType: "application/pdf", size: PDF.length });

    // Removal goes through the JSON body, even though this router sits before the global parser.
    const removed = await request(app)
      .post(`/api/releases/${id}/files/${res.body.files[0].id}/remove`)
      .set("cookie", editorCookie)
      .set("x-gcpe-request", "1")
      .send({ version: res.body.version });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ hasTranslations: false, files: [] });
  });

  it("a viewer can't upload: 403, nothing stored", async () => {
    const { id, version } = await create();
    const res = await upload(filesPath(id, version, "fr.pdf"), viewerCookie, PDF);
    expect(res.status).toBe(403);
    expect(await store.list(`releases/${id}`)).toEqual([]);
  });

  it("an anonymous upload is 401", async () => {
    const { id, version } = await create();
    const res = await request(app).post(filesPath(id, version, "fr.pdf")).set("content-type", "application/pdf").send(PDF);
    expect(res.status).toBe(401);
  });

  it("a hostile file name is stored under a safe generated key", async () => {
    const { id, version } = await create();
    const res = await upload(filesPath(id, version, "../../etc/passwd.pdf"), editorCookie, PDF);
    expect(res.status).toBe(201);
    const [obj] = await store.list(`releases/${id}`);
    expect(obj!.key).toMatch(/-etc-passwd\.pdf$/);
    expect(obj!.key).not.toContain("..");
    expect(obj!.key.startsWith(`releases/${id}/translations/`)).toBe(true);
    expect(res.body.files[0].url).toBe(`/files/${obj!.key}`);
  });

  it("a file whose bytes don't match a PDF is 422 and nothing is stored", async () => {
    const { id, version } = await create();
    const exe = Buffer.from("MZ\x90\x00 pretend exe", "latin1");
    const res = await upload(filesPath(id, version, "budget.pdf"), editorCookie, exe);
    expect(res.status).toBe(422);
    expect(res.body.problems).toEqual(["This file isn't a PDF."]);
    expect(await store.list(`releases/${id}`)).toEqual([]);
  });

  it("a bad kind or version is a 400", async () => {
    const { id, version } = await create();
    expect((await upload(`/api/releases/${id}/files?kind=photo&version=${version}&name=a.pdf`, editorCookie, PDF)).status).toBe(400);
    expect((await upload(`/api/releases/${id}/files?kind=asset&version=x&name=a.pdf`, editorCookie, PDF)).status).toBe(400);
    expect((await upload(`/api/releases/not-a-uuid/files?kind=asset&version=1&name=a.pdf`, editorCookie, PDF)).status).toBe(404);
  });

  it("a 26 MiB body is 413", async () => {
    const { id, version } = await create();
    const big = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024)]);
    const res = await upload(filesPath(id, version, "big.pdf"), editorCookie, big);
    expect(res.status).toBe(413);
    expect(await store.list(`releases/${id}`)).toEqual([]);
  });

  it("page images: a site editor uploads (201), a viewer can't (403), anyone signed in reads the bytes, a duplicate name is 409", async () => {
    const path = "/api/page-images?name=BC%20Logo&altEn=B.C.%20logo&altFr=Logo&sortOrder=2";
    const created = await upload(path, siteEditorCookie, PNG);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: "BC Logo" });

    expect((await upload("/api/page-images?name=Other", viewerCookie, PNG)).status).toBe(403);

    const img = await request(app).get(`/api/page-images/${created.body.id}/image`).set("cookie", viewerCookie).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["cache-control"]).toBe("private, max-age=300");
    expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);

    const dup = await upload(path, editorCookie, PNG);
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "A page image with that name already exists." });

    const updated = await request(app)
      .put(`/api/page-images/${created.body.id}`)
      .set("cookie", siteEditorCookie)
      .set("x-gcpe-request", "1")
      .send({ altEn: "New alt", isActive: false });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ altEn: "New alt", isActive: false });

    expect((await request(app).get("/api/page-images/00000000-0000-4000-8000-000000000999/image").set("cookie", viewerCookie)).status).toBe(404);
  });
});

describe("GET /api/releases/:id/asset-status", () => {
  let tdb: TestDatabase;
  let editorCookie: string;
  let viewerCookie: string;
  const visibility = new Map<string, "public" | "private" | "missing" | "down">();
  const flickr: FlickrClient = {
    async getVisibility(photoId) {
      const v = visibility.get(photoId);
      if (v === "missing") throw new FlickrError("not-found", "Flickr flickr.photos.getInfo: Photo not found (code 1)");
      if (v === "down" || v === undefined) throw new FlickrError("unavailable", "Flickr flickr.photos.getInfo: HTTP 503");
      return v;
    },
    makePublic: () => Promise.reject(new Error("not used")),
    confirmPublic: () => Promise.reject(new Error("not used")),
    staticImageUrl: () => Promise.reject(new Error("not used")),
  };
  const appWith = (f: FlickrClient | null) =>
    createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, flickr: f });
  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000b", name: "Sam", email: "sam@example.invalid", roles })).token}`;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    editorCookie = await cookieFor(["NRMS.Editor"]);
    viewerCookie = await cookieFor(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  async function releaseWithAsset(app: ReturnType<typeof createApp>, assetUrl: string | null): Promise<string> {
    const created = await request(app).post("/api/releases").set("cookie", editorCookie).set("x-gcpe-request", "1").send(sampleCreate);
    expect(created.status).toBe(201);
    if (assetUrl !== null) {
      const saved = await request(app)
        .put(`/api/releases/${created.body.id}/asset`)
        .set("cookie", editorCookie)
        .set("x-gcpe-request", "1")
        .send({ version: created.body.version, assetUrl, assetAltText: null, hasMediaAssets: false });
      expect(saved.status).toBe(200);
    }
    return created.body.id as string;
  }
  const status = (app: ReturnType<typeof createApp>, id: string) => request(app).get(`/api/releases/${id}/asset-status`).set("cookie", viewerCookie);

  it("a viewer sees none / youtube / live without any Flickr call", async () => {
    const app = appWith(flickr);
    for (const [url, body] of [
      [null, { kind: "none" }],
      ["https://www.youtube.com/watch?v=abc", { kind: "youtube" }],
      ["https://news.gov.bc.ca/live", { kind: "live" }],
    ] as const) {
      const res = await status(app, await releaseWithAsset(app, url));
      expect(res.status).toBe(200);
      expect(res.body).toEqual(body);
    }
  });

  it("a Flickr asset reports public, private, missing and unavailable with their messages", async () => {
    const app = appWith(flickr);
    visibility.set("53000000011", "public").set("53000000001", "private").set("53000000002", "missing").set("53000000003", "down");
    const cases = [
      ["53000000011", "public", "Public on Flickr."],
      ["53000000001", "private", "Private — will be made public when the release publishes."],
      ["53000000002", "missing", "This photo no longer exists on Flickr."],
      ["53000000003", "unavailable", "Flickr can't be reached right now."],
    ] as const;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [photoId, state, message] of cases) {
        const res = await status(app, await releaseWithAsset(app, `https://www.flickr.com/photos/bcgovphotos/${photoId}/`));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ kind: "flickr", photoId, state, message });
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("with no Flickr configured, a Flickr asset is unavailable", async () => {
    const app = appWith(null);
    const res = await status(app, await releaseWithAsset(app, "https://www.flickr.com/photos/bcgovphotos/53000000011/"));
    expect(res.body).toEqual({ kind: "flickr", photoId: "53000000011", state: "unavailable", message: "Flickr can't be reached right now." });
  });

  it("404s an unknown or malformed release id, and refuses anonymous callers", async () => {
    const app = appWith(flickr);
    expect((await status(app, "00000000-0000-4000-8000-000000000999")).status).toBe(404);
    expect((await status(app, "not-a-uuid")).status).toBe(404);
    expect((await request(app).get("/api/releases/00000000-0000-4000-8000-000000000999/asset-status")).status).toBe(401);
  });

  it("an unparseable Flickr link is refused on save with 422", async () => {
    const app = appWith(flickr);
    const created = await request(app).post("/api/releases").set("cookie", editorCookie).set("x-gcpe-request", "1").send(sampleCreate);
    const res = await request(app)
      .put(`/api/releases/${created.body.id}/asset`)
      .set("cookie", editorCookie)
      .set("x-gcpe-request", "1")
      .send({ version: created.body.version, assetUrl: "https://www.flickr.com/photos/bcgovphotos/", assetAltText: null, hasMediaAssets: false });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "That Flickr link doesn't point to a photo.", problems: ["That Flickr link doesn't point to a photo."] });
  });
});
