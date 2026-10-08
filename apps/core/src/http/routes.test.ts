import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword, localLoginRouter } from "@gcpe/auth";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { MAX_EVENT_BYTES } from "@gcpe/events";
import { createApp } from "../app";
import * as organizationsService from "../services/organizations";
import * as republishService from "../services/republish";
import * as termsService from "../services/terms";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://core";

describe("Core HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let reader: string;
  let directoryService: string;
  let editorOnly: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(issuer).setAudience(audience).setSubject("svc").setExpirationTime("5m").sign(pair.privateKey);
    admin = await sign(["Core.Admin"]);
    reader = await sign([]);
    directoryService = await sign(["Core.AdminDirectory"]);
    editorOnly = await sign(["NRMS.Editor"]);
    app = createApp({ db: tdb.db, subscribers: [], auth: { issuer, audience, keys } });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("health endpoints need no auth", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
    expect((await request(app).get("/health/ready")).body).toEqual({ status: "ok" });
  });

  it("requires a token for reads and Core.Admin for writes", async () => {
    expect((await request(app).get("/api/organizations")).status).toBe(401);
    expect((await request(app).put("/api/organizations/health").set("authorization", `Bearer ${reader}`).send(healthOrg)).status).toBe(403);
  });

  it("authenticates before parsing request bodies", async () => {
    const malformed = await request(app).put("/api/organizations/health").set("content-type", "application/json").send("{not json");
    // Parsing first would answer 400 here; an anonymous caller must get 401 without the body being parsed.
    expect(malformed.status).toBe(401);
  });

  it("creates, reads, lists and deactivates an organization", async () => {
    const put = await request(app).put("/api/organizations/health").set("authorization", `Bearer ${admin}`).send(healthOrg);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject(healthOrg);
    expect((await request(app).get("/api/organizations/health").set("authorization", `Bearer ${reader}`)).body.key).toBe("health");
    expect((await request(app).get("/api/organizations").set("authorization", `Bearer ${reader}`)).body).toHaveLength(1);
    expect((await request(app).post("/api/organizations/health/deactivate").set("authorization", `Bearer ${admin}`)).status).toBe(204);
    expect((await request(app).post("/api/organizations/nope/deactivate").set("authorization", `Bearer ${admin}`)).status).toBe(404);
  });

  it("400 when the body key does not match the path or is invalid", async () => {
    expect((await request(app).put("/api/organizations/other").set("authorization", `Bearer ${admin}`).send(healthOrg)).status).toBe(400);
    expect((await request(app).put("/api/organizations/health").set("authorization", `Bearer ${admin}`).send({ key: "health" })).status).toBe(400);
  });

  it("PUT /organizations/:key/hq is Core.Admin only, 404s an unknown key and 400s a non-boolean", async () => {
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });
    await request(app).put("/api/organizations/health").set(auth(admin)).send(healthOrg).expect(200);
    expect((await request(app).put("/api/organizations/health/hq").set(auth(editorOnly)).send({ isHq: true })).status).toBe(403);
    const set = await request(app).put("/api/organizations/health/hq").set(auth(admin)).send({ isHq: true });
    expect(set.status).toBe(200);
    expect(set.body.isHq).toBe(true);
    expect((await request(app).get("/api/organizations/health").set(auth(reader))).body.isHq).toBe(true);
    expect((await request(app).put("/api/organizations/nope/hq").set(auth(admin)).send({ isHq: true })).status).toBe(404);
    expect((await request(app).put("/api/organizations/health/hq").set(auth(admin)).send({ isHq: "yes" })).status).toBe(400);
  });

  it("handles terms and rejects unknown kinds", async () => {
    const term = { kind: "tag", key: "covid-19", displayName: "COVID-19", sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null } };
    expect((await request(app).put("/api/terms/tag/covid-19").set("authorization", `Bearer ${admin}`).send(term)).status).toBe(200);
    expect((await request(app).get("/api/terms/tag").set("authorization", `Bearer ${reader}`)).body).toHaveLength(1);
    expect((await request(app).get("/api/terms/planet").set("authorization", `Bearer ${reader}`)).status).toBe(404);
  });

  it("hides internal error details on unexpected failures", async () => {
    const spy = vi
      .spyOn(organizationsService, "upsertOrganization")
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "organizations_pkey"'));
    try {
      const res = await request(app)
        .put("/api/organizations/boom")
        .set("authorization", `Bearer ${admin}`)
        .send({ ...healthOrg, key: "boom" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal error" });
      expect(JSON.stringify(res.body)).not.toContain("constraint");
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["GET /api/organizations", organizationsService, "listOrganizations", "get", "/api/organizations"],
    ["GET /api/organizations/:key", organizationsService, "getOrganization", "get", "/api/organizations/health"],
    ["POST /api/organizations/:key/deactivate", organizationsService, "deactivateOrganization", "post", "/api/organizations/health/deactivate"],
    ["GET /api/terms/:kind", termsService, "listTerms", "get", "/api/terms/tag"],
    ["GET /api/terms/:kind/:key", termsService, "getTerm", "get", "/api/terms/tag/x"],
    ["PUT /api/terms/:kind/:key", termsService, "upsertTerm", "put", "/api/terms/tag/x"],
    ["POST /api/terms/:kind/:key/deactivate", termsService, "deactivateTerm", "post", "/api/terms/tag/x/deactivate"],
    ["POST /api/admin/republish", republishService, "republishAll", "post", "/api/admin/republish"],
  ] as const)("%s returns a generic 500 without leaking the error", async (_name, mod, fn, method, path) => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(mod as Record<string, (...a: unknown[]) => unknown>, fn).mockRejectedValueOnce(new Error("secret db detail at /srv/x.ts:1"));
    try {
      const term = { kind: "tag", key: "x", displayName: "X", sortOrder: 0, isActive: true, social: healthOrg.social };
      const res = await request(app)[method](path).set("authorization", `Bearer ${admin}`).send(method === "put" ? term : undefined);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal error" });
      expect(res.text).not.toContain("secret");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("logs only a safe label for an unexpected failure, never the query's bound parameters or an email", async () => {
    const lines: unknown[][] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args));
    const failed = Object.assign(new Error('Failed query: update "organizations" set "contact" = $1\nparams: {"emailAddress":"robin.staff@example.test"}'), {
      cause: Object.assign(new Error('value for "contact" robin.staff@example.test'), { code: "22001" }),
    });
    const spy = vi.spyOn(organizationsService, "upsertOrganization").mockRejectedValueOnce(failed);
    try {
      const res = await request(app).put("/api/organizations/health").set("authorization", `Bearer ${admin}`).send(healthOrg);
      expect(res.status).toBe(500);
      expect(lines).toHaveLength(1);
      const logged = lines[0]!.map((a) => (a instanceof Error ? `${a.message} ${a.stack} ${String(a.cause)}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      expect(logged).toContain("22001");
      expect(logged).not.toContain("example.test");
      expect(logged).not.toContain("params");
      expect(lines[0]!.every((a) => typeof a === "string")).toBe(true);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("rejects admin bodies over MAX_EVENT_BYTES with 413", async () => {
    const big = { ...healthOrg, key: "big", minister: { ...healthOrg.minister, detailsHtml: "x".repeat(MAX_EVENT_BYTES) } };
    const res = await request(app).put("/api/organizations/big").set("authorization", `Bearer ${admin}`).send(big);
    expect(res.status).toBe(413);
  });

  it("413 when the body fits but the resulting event envelope would not", async () => {
    // Body under the limit, but the envelope adds metadata (ids, timestamps, updatedAt) on top.
    const pad = MAX_EVENT_BYTES - JSON.stringify({ ...healthOrg, key: "edge" }).length - 20;
    const edge = { ...healthOrg, key: "edge", minister: { ...healthOrg.minister, detailsHtml: "x".repeat(pad) } };
    expect(JSON.stringify(edge).length).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    const res = await request(app).put("/api/organizations/edge").set("authorization", `Bearer ${admin}`).send(edge);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "record too large to publish" });
    expect((await request(app).get("/api/organizations/edge").set("authorization", `Bearer ${reader}`)).status).toBe(404);
  });

  // Final review M10: Core gains the shared JSON error handler — body-parser failures must
  // come back as JSON, not finalhandler's default HTML page.
  it("returns malformed-JSON 400s and oversized-body 413s as JSON, not HTML", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const malformed = await request(app)
        .put("/api/organizations/health")
        .set("authorization", `Bearer ${admin}`)
        .set("content-type", "application/json")
        .send("{not json");
      expect(malformed.status).toBe(400);
      expect(malformed.headers["content-type"]).toMatch(/^application\/json/);
      expect(malformed.text).not.toMatch(/<html|at \S+ \(|\.ts:\d+:\d+/i);

      const big = { ...healthOrg, key: "big", minister: { ...healthOrg.minister, detailsHtml: "x".repeat(MAX_EVENT_BYTES) } };
      const tooBig = await request(app).put("/api/organizations/big").set("authorization", `Bearer ${admin}`).send(big);
      expect(tooBig.status).toBe(413);
      expect(tooBig.headers["content-type"]).toMatch(/^application\/json/);
      expect(tooBig.body).toEqual({ error: "request entity too large" });
    } finally {
      errSpy.mockRestore();
    }
  });

  // Plan 3d task 4: Project Blue Bridge's admin directory — Core.Admin itself or NRMS's
  // narrow Core.AdminDirectory service token can read it; nothing else can.
  it("GET /api/directory/admin-emails: Core.Admin and Core.AdminDirectory can read it; anything else is refused", async () => {
    const created = await request(app)
      .post("/api/users")
      .set("authorization", `Bearer ${admin}`)
      .send({ email: "directory-admin@example.test", displayName: "Directory Admin", roles: ["Core.Admin"], password: "correct horse battery" });
    expect(created.status).toBe(201);

    const asAdmin = await request(app).get("/api/directory/admin-emails").set("authorization", `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.emails).toContain("directory-admin@example.test");

    const asService = await request(app).get("/api/directory/admin-emails").set("authorization", `Bearer ${directoryService}`);
    expect(asService.status).toBe(200);
    expect(asService.body.emails).toEqual(asAdmin.body.emails);

    expect((await request(app).get("/api/directory/admin-emails").set("authorization", `Bearer ${editorOnly}`)).status).toBe(403);
    expect((await request(app).get("/api/directory/admin-emails").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).get("/api/directory/admin-emails")).status).toBe(401);
  });

  it("republish returns the number of enqueued events", async () => {
    const res = await request(app).post("/api/admin/republish").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(202);
    // 1 organization + 1 term + 1 user (the Core.Admin created by the directory-admin-emails test above).
    expect(res.body.enqueued).toBe(3);
  });

  // Task 3: local admin login, end to end on the Core reference app — later apps copy this wiring.
  it("local admin login: logging in and using the token for an admin write succeeds", async () => {
    const secret = "z".repeat(40) + "-core-local-test";
    const passwordHash = await hashPassword("local-test-pass");
    const localApp = createApp({
      db: tdb.db,
      subscribers: [],
      auth: { local: { secret } },
      loginRouter: localLoginRouter({ username: "admin", passwordHash, secret }),
    });

    const login = await request(localApp).post("/auth/local/token").send({ username: "admin", password: "local-test-pass" });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ token_type: "Bearer" });

    const put = await request(localApp)
      .put("/api/organizations/local-login")
      .set("authorization", `Bearer ${login.body.access_token}`)
      .send({ ...healthOrg, key: "local-login" });
    expect(put.status).toBe(200);
  });

  // Fix round 1, Minor #4: "trust proxy" must be set so the login rate limiter keys on the
  // real client IP (from X-Forwarded-For) behind the OpenShift router / SiteGround nginx,
  // not on the one loopback address every request arrives from in-process. Without it, two
  // different clients would share one rate-limit budget.
  it("rate-limits local login per real client IP (trust proxy honours X-Forwarded-For)", async () => {
    const secret = "w".repeat(40) + "-trust-proxy-test";
    const passwordHash = await hashPassword("trust-proxy-pass");
    const ipApp = createApp({
      db: tdb.db,
      subscribers: [],
      auth: { local: { secret } },
      loginRouter: localLoginRouter({ username: "admin", passwordHash, secret }),
    });
    const attempt = (ip: string) =>
      request(ipApp).post("/auth/local/token").set("X-Forwarded-For", ip).send({ username: "admin", password: "wrong" });

    const ipA = "203.0.113.10";
    const ipB = "203.0.113.20";
    const ipAStatuses: number[] = [];
    for (let i = 0; i < 10; i++) ipAStatuses.push((await attempt(ipA)).status);
    expect(ipAStatuses.every((s) => s === 401)).toBe(true);
    expect((await attempt(ipA)).status).toBe(429); // ipA's 11th request: budget exhausted

    // A different client IP must still have its own, unexhausted budget.
    expect((await attempt(ipB)).status).toBe(401);
  });
});
