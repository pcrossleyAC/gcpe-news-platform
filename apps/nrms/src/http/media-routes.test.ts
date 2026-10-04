import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";

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
