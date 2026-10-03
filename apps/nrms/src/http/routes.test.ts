import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword, localLoginRouter } from "@gcpe/auth";
import { MAX_EVENT_BYTES } from "@gcpe/events";
import { createNrmsTestDb, sampleDraft } from "../../test/helpers";
import { createApp } from "../app";
import * as releasesService from "../releases";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://nrms";

describe("NRMS HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let editor: string;
  let reader: string;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("svc")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    editor = await sign(["NRMS.Editor"]);
    reader = await sign([]);
    app = createApp({ db: tdb.db, auth: { issuer, audience, keys } });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("GET /health/live needs no auth", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
  });

  it("requires a token, and NRMS.Editor role, to create a release", async () => {
    expect((await request(app).post("/api/releases").send(sampleDraft)).status).toBe(401);
    expect((await request(app).post("/api/releases").set("authorization", `Bearer ${reader}`).send(sampleDraft)).status).toBe(403);
  });

  it("creates a release and rejects the same key again with 409", async () => {
    const created = await request(app).post("/api/releases").set("authorization", `Bearer ${editor}`).send(sampleDraft);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ key: sampleDraft.key });

    const dup = await request(app).post("/api/releases").set("authorization", `Bearer ${editor}`).send(sampleDraft);
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "release exists" });
  });

  it("400s an invalid key with issues", async () => {
    const res = await request(app)
      .post("/api/releases")
      .set("authorization", `Bearer ${editor}`)
      .send({ ...sampleDraft, key: "../x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid request");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it("413s a release whose body fits under MAX_EVENT_BYTES but whose published envelope would not", async () => {
    // Body stays under express.json's MAX_EVENT_BYTES limit (so body-parser lets it through);
    // the envelope's extra metadata (id, timestamps, correlationId) pushes it over, which
    // createDraft's assertPublishable catches as ReleaseTooLargeError.
    const key = "EDGE-HTTP-1";
    const pad = MAX_EVENT_BYTES - JSON.stringify({ ...sampleDraft, key }).length - 100;
    const draft = { ...sampleDraft, key, documents: [{ ...sampleDraft.documents[0]!, detailsHtml: "x".repeat(pad) }] };
    expect(JSON.stringify(draft).length).toBeLessThanOrEqual(MAX_EVENT_BYTES);

    const res = await request(app).post("/api/releases").set("authorization", `Bearer ${editor}`).send(draft);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "release too large" });
    expect(await releasesService.getRelease(tdb.db, key)).toBeUndefined();
  });

  it("schedules a release, 400s a publishAt missing a UTC offset, and 404s an unknown key", async () => {
    const key = "SCHED-1";
    await request(app).post("/api/releases").set("authorization", `Bearer ${editor}`).send({ ...sampleDraft, key });

    const ok = await request(app)
      .post(`/api/releases/${key}/schedule`)
      .set("authorization", `Bearer ${editor}`)
      .send({ publishAt: "2026-10-03T10:00:00-07:00" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ key, status: "scheduled" });
    expect(typeof ok.body.publishAt).toBe("string");

    const noOffset = await request(app)
      .post(`/api/releases/${key}/schedule`)
      .set("authorization", `Bearer ${editor}`)
      .send({ publishAt: "2026-10-03T10:00:00" });
    expect(noOffset.status).toBe(400);

    const unknown = await request(app)
      .post("/api/releases/nope/schedule")
      .set("authorization", `Bearer ${editor}`)
      .send({ publishAt: "2026-10-03T10:00:00-07:00" });
    expect(unknown.status).toBe(404);
  });

  it("409s scheduling an already-published release", async () => {
    const key = "SCHED-PUBLISHED-1";
    await request(app).post("/api/releases").set("authorization", `Bearer ${editor}`).send({ ...sampleDraft, key });
    await tdb.pool.query("UPDATE releases SET status = 'published' WHERE key = $1", [key]);

    const res = await request(app)
      .post(`/api/releases/${key}/schedule`)
      .set("authorization", `Bearer ${editor}`)
      .send({ publishAt: "2026-10-03T10:00:00-07:00" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "release already published" });
  });

  it("gets a release by key (NRMS.Editor only) with lastError present, and 404s an unknown key", async () => {
    const key = "GET-1";
    await request(app).post("/api/releases").set("authorization", `Bearer ${editor}`).send({ ...sampleDraft, key });
    const res = await request(app).get(`/api/releases/${key}`).set("authorization", `Bearer ${editor}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key, status: "draft", lastError: null });

    const notFound = await request(app).get("/api/releases/nope").set("authorization", `Bearer ${editor}`);
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ error: "not found" });
  });

  // M1: an unpublished draft is embargoed — GET must require NRMS.Editor like every other
  // route, not be readable by any valid token.
  it("requires a token, and NRMS.Editor role, to get a release", async () => {
    const key = "GET-AUTH-1";
    await request(app).post("/api/releases").set("authorization", `Bearer ${editor}`).send({ ...sampleDraft, key });

    expect((await request(app).get(`/api/releases/${key}`)).status).toBe(401);
    expect((await request(app).get(`/api/releases/${key}`).set("authorization", `Bearer ${reader}`)).status).toBe(403);
  });

  it("hides internal error details on unexpected failures", async () => {
    const spy = vi.spyOn(releasesService, "getRelease").mockRejectedValueOnce(new Error("secret db detail at /srv/x.ts:1"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request(app).get("/api/releases/whatever").set("authorization", `Bearer ${editor}`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal error" });
      expect(res.text).not.toContain("secret");
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // Task 3: local admin login works against NRMS, end to end — proves the same wiring Core uses.
  it("local admin login: logging in and using the token to create a release succeeds", async () => {
    const secret = "y".repeat(40) + "-nrms-local-test";
    const passwordHash = await hashPassword("local-test-pass");
    const localApp = createApp({
      db: tdb.db,
      auth: { local: { secret } },
      loginRouter: localLoginRouter({ username: "admin", passwordHash, secret }),
    });

    const login = await request(localApp).post("/auth/local/token").send({ username: "admin", password: "local-test-pass" });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ token_type: "Bearer" });

    const created = await request(localApp)
      .post("/api/releases")
      .set("authorization", `Bearer ${login.body.access_token}`)
      .send({ ...sampleDraft, key: "LOCAL-LOGIN-1" });
    expect(created.status).toBe(201);
  });
});
