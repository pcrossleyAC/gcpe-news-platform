import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword, localLoginRouter, mintSession } from "@gcpe/auth";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import * as store from "../releases/store";

const SECRET = "z".repeat(40) + "-nrms-session-test";
const STALE = "Someone else changed this release — reload to see their changes";

describe("NRMS HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let editorCookie: string;
  let viewerCookie: string;

  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000a", name: "Pat Editor", email: "pat@example.invalid", roles })).token}`;
  const post = (path: string, cookie: string, body: unknown) => request(app).post(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body as object);
  const create = async (over: Record<string, unknown> = {}) => {
    const res = await post("/api/releases", editorCookie, { ...sampleCreate, ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  };

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" } });
    editorCookie = await cookieFor(["NRMS.Editor"]);
    viewerCookie = await cookieFor(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("GET /health/live needs no auth", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
  });

  it("a viewer can read categories and releases but can't create one", async () => {
    const created = await create();
    const cats = await request(app).get("/api/categories").set("cookie", viewerCookie);
    expect(cats.status).toBe(200);
    expect(cats.body.ministries.map((m: { key: string }) => m.key)).toContain("health");
    const got = await request(app).get(`/api/releases/${created.id}`).set("cookie", viewerCookie);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: created.id, status: "draft", statusText: "Draft" });
    const denied = await post("/api/releases", viewerCookie, sampleCreate);
    expect(denied.status).toBe(403);
  });

  it("an editor creates a draft: 201 with the view and its status wording", async () => {
    const res = await post("/api/releases", editorCookie, sampleCreate);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "draft", statusText: "Draft", version: 1, reference: null, key: null });
    expect(res.body.documents[0].languages[0].headline).toBe(sampleCreate.headline);
  });

  it("approve gives a reference; approving again is a 409 with the reason", async () => {
    const { id } = await create();
    const ok = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.reference).toMatch(/^NEWS-\d{5}$/);
    expect(ok.body.key).toMatch(/^\d{4}HLTH\d{4}-\d{6}$/);
    expect(ok.body.status).toBe("approved");
    const again = await post(`/api/releases/${id}/approve`, editorCookie, { version: ok.body.version });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "This has already been approved." });
  });

  it("schedule now → 200 scheduled; a stale version → 409 with the reload message", async () => {
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const s = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("scheduled");
    expect(typeof s.body.statusText).toBe("string");
    const stale = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: STALE });
  });

  it("cancel returns a scheduled release to approved", async () => {
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const s = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    const c = await post(`/api/releases/${id}/cancel`, editorCookie, { version: s.body.version });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("approved");
  });

  it("an unknown sector is a 422 with the problem list", async () => {
    const res = await post("/api/releases", editorCookie, { ...sampleCreate, sectors: ["nope"] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Unknown sector: nope", problems: ["Unknown sector: nope"] });
  });

  it("a blank headline is a 400 with zod issues", async () => {
    const res = await post("/api/releases", editorCookie, { ...sampleCreate, headline: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid request");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it("an unknown id is a 404; deleting a scheduled release is a 409", async () => {
    const nf = await request(app).get("/api/releases/not-a-uuid").set("cookie", editorCookie);
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: "not found" });
    expect((await post("/api/releases/00000000-0000-4000-8000-000000000999/approve", editorCookie, { version: 1 })).status).toBe(404);
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const s = await post(`/api/releases/${id}/schedule`, editorCookie, { version: a.body.version, publishAt: "now" });
    const del = await post(`/api/releases/${id}/delete`, editorCookie, { version: s.body.version });
    expect(del.status).toBe(409);
    expect(typeof del.body.error).toBe("string");
  });

  it("delete: a never-approved draft is deleted; an approved one is hidden and then reads as 404", async () => {
    const d = await create();
    expect((await post(`/api/releases/${d.id}/delete`, editorCookie, { version: 1 })).body).toEqual({ result: "deleted" });
    const { id } = await create();
    const a = await post(`/api/releases/${id}/approve`, editorCookie, { version: 1 });
    const hidden = await post(`/api/releases/${id}/delete`, editorCookie, { version: a.body.version });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ result: "hidden" });
    expect((await request(app).get(`/api/releases/${id}`).set("cookie", editorCookie)).status).toBe(404);
  });

  it("a cookie-authenticated POST without x-gcpe-request is refused with 403", async () => {
    const res = await request(app).post("/api/releases").set("cookie", editorCookie).send(sampleCreate);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "missing X-GCPE-Request header" });
  });

  it("hides internal error details on unexpected failures", async () => {
    const spy = vi.spyOn(store, "loadView").mockRejectedValueOnce(new Error("secret db detail at /srv/x.ts:1"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request(app).get("/api/releases/00000000-0000-4000-8000-000000000999").set("cookie", editorCookie);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal error" });
      expect(res.text).not.toContain("secret");
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("local admin login: the token creates a release", async () => {
    const secret = "y".repeat(40) + "-nrms-local-test";
    const passwordHash = await hashPassword("local-test-pass");
    const localApp = createApp({
      db: tdb.db,
      auth: { local: { secret } },
      loginRouter: localLoginRouter({ username: "admin", passwordHash, secret }),
      eventSecrets: {},
      workflow: { timeZone: "America/Vancouver" },
    });
    const login = await request(localApp).post("/auth/local/token").send({ username: "admin", password: "local-test-pass" });
    expect(login.status).toBe(200);
    const created = await request(localApp).post("/api/releases").set("authorization", `Bearer ${login.body.access_token}`).send(sampleCreate);
    expect(created.status).toBe(201);
  });
});
