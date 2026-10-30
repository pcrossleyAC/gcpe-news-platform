import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword, localLoginRouter } from "@gcpe/auth";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { MAX_EVENT_BYTES, outboxEvents } from "@gcpe/events";
import { eq } from "drizzle-orm";
import { organizations, userOrganizations, users } from "../db/schema";
import { createApp } from "../app";
import * as organizationsService from "../services/organizations";
import * as republishService from "../services/republish";
import * as termsService from "../services/terms";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://core";

describe("Core HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let staffApp: ReturnType<typeof createApp>;
  let admin: string;
  let reader: string;
  let directoryService: string;
  let editorOnly: string;
  let siteEditor: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

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
    siteEditor = await sign(["NRMS.SiteEditor"]);
    app = createApp({ db: tdb.db, subscribers: [], auth: { issuer, audience, keys } });
    staffApp = createApp({ db: tdb.db, subscribers: [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }], auth: { issuer, audience, keys } });
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

  it("time-zone-check: any signed-in caller (no roles needed) gets the tenant zone and the server's offset; anonymous gets 401", async () => {
    expect((await request(app).get("/api/time-zone-check")).status).toBe(401);
    const res = await request(app).get("/api/time-zone-check").set("authorization", `Bearer ${reader}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: "America/Vancouver", tzCheck: { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 } });
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
    await request(app).put("/api/organizations/health?overwriteStaffEdits=true").set(auth(admin)).send(healthOrg).expect(200);
    expect((await request(app).put("/api/organizations/health/hq").set(auth(editorOnly)).send({ isHq: true })).status).toBe(403);
    const set = await request(app).put("/api/organizations/health/hq").set(auth(admin)).send({ isHq: true });
    expect(set.status).toBe(200);
    expect(set.body.isHq).toBe(true);
    expect((await request(app).get("/api/organizations/health").set(auth(reader))).body.isHq).toBe(true);
    expect((await request(app).put("/api/organizations/nope/hq").set(auth(admin)).send({ isHq: true })).status).toBe(404);
    expect((await request(app).put("/api/organizations/health/hq").set(auth(admin)).send({ isHq: "yes" })).status).toBe(400);
  });

  it("PUT /api/organizations/:key/public is Core.Admin only and returns the record", async () => {
    await request(app).put("/api/organizations/health?overwriteStaffEdits=true").set(auth(admin)).send(healthOrg).expect(200);
    const res = await request(app).put("/api/organizations/health/public").set(auth(admin)).send({ isPublic: false });
    expect(res.status).toBe(200);
    expect(res.body.isPublic).toBe(false);
    expect((await request(app).put("/api/organizations/health/public").set(auth(editorOnly)).send({ isPublic: true })).status).toBe(403);
    expect((await request(app).put("/api/organizations/no-such-org/public").set(auth(admin)).send({ isPublic: true })).status).toBe(404);
    expect((await request(app).put("/api/organizations/health/public").set(auth(admin)).send({ isPublic: "no" })).status).toBe(400);
  });

  it("handles terms and rejects unknown kinds", async () => {
    const term = { kind: "tag", key: "covid-19", displayName: "COVID-19", sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null } };
    expect((await request(app).put("/api/terms/tag/covid-19").set("authorization", `Bearer ${admin}`).send(term)).status).toBe(200);
    expect((await request(app).get("/api/terms/tag").set("authorization", `Bearer ${reader}`)).body).toHaveLength(1);
    expect((await request(app).get("/api/terms/planet").set("authorization", `Bearer ${reader}`)).status).toBe(404);
  });

  describe("staff term edits", () => {
    const social = { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null };
    const term = (key: string, extra: Record<string, unknown> = {}) => ({ kind: "tag", key, displayName: "T", sortOrder: 0, isActive: true, social, ...extra });
    const put = (key: string, body: unknown, token = () => admin) => request(staffApp).put(`/api/terms/tag/${key}`).set(auth(token())).send(body as object);
    // The shared DB is not truncated between tests, so leave no terms or events behind.
    afterEach(async () => {
      await tdb.pool.query("DELETE FROM terms WHERE key IN ('new-tag','New-Tag','Legacy-Tag','legacy-tag','blank-tag','raced-tag','to-retire','nope')");
      await tdb.pool.query("DELETE FROM outbox_events WHERE aggregate_id LIKE 'tag:%'");
    });
    const eventsFor = async (key: string) => (await tdb.db.select().from(outboxEvents)).filter((e) => e.aggregateId === `tag:${key}`);

    it("PUT /api/terms/tag/new-tag with displayName '  New tag ' stores 'New tag' and enqueues tag.upserted", async () => {
      const res = await put("new-tag", term("new-tag", { displayName: "  New tag " }));
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe("New tag");
      const events = await eventsFor("new-tag");
      expect(events.map((e) => e.type)).toEqual(["tag.upserted"]);
    });

    it("PUT a new key 'New-Tag' answers 400 { error: 'key-format' }; an existing key's case variant answers 409 { error: 'key-taken' }", async () => {
      const bad = await put("New-Tag", term("New-Tag"));
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: "key-format" });
      await tdb.pool.query("INSERT INTO terms (kind, key, display_name, sort_order, is_active, social, updated_at) VALUES ('tag', 'Legacy-Tag', 'Legacy', 0, true, $1, now())", [JSON.stringify(social)]);
      const taken = await put("legacy-tag", term("legacy-tag"));
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ error: "key-taken" });
      // A blank name is a 400 too.
      expect((await put("blank-tag", term("blank-tag", { displayName: "  " }))).body).toEqual({ error: "name-required" });
    });

    it("PUT with isActive false on an existing term stores it inactive and enqueues tag.upserted with isActive false", async () => {
      await put("to-retire", term("to-retire"));
      const res = await put("to-retire", term("to-retire", { isActive: false }));
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);
      const events = await eventsFor("to-retire");
      expect(events.map((e) => e.type)).toEqual(["tag.upserted", "tag.upserted"]);
      expect(((events[1]!.envelope as { data: { isActive: boolean } }).data.isActive)).toBe(false);
    });

    it("PUT renames an existing legacy mixed-case key (200): the format rule only guards new keys", async () => {
      await termsService.upsertTerm(tdb.db, { kind: "tag", key: "Legacy-Tag", displayName: null as unknown as string, sortOrder: 0, isActive: true, social }, []);
      const res = await put("Legacy-Tag", term("Legacy-Tag", { displayName: " Legacy tag " }));
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe("Legacy tag");
    });

    it("PUT answers 409 key-taken when the write loses a create race (unique violation on terms_kind_key)", async () => {
      const spy = vi
        .spyOn(termsService, "upsertTerm")
        .mockRejectedValueOnce(Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("duplicate key"), { code: "23505", constraint: "terms_kind_key" }) }));
      try {
        const res = await put("raced-tag", term("raced-tag"));
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "key-taken" });
      } finally {
        spy.mockRestore();
      }
    });

    const post = (body: unknown, token = () => admin) => request(staffApp).post("/api/terms/tag").set(auth(token())).send(body as object);

    it("POST /api/terms/tag creates a new tag: 201, and enqueues tag.upserted", async () => {
      const res = await post(term("new-tag", { displayName: " New tag " }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ key: "new-tag", displayName: "New tag" });
      expect((await eventsFor("new-tag")).map((e) => e.type)).toEqual(["tag.upserted"]);
    });

    it("POST with a key already in use answers 409 with a plain message and changes nothing", async () => {
      const own = { twitterUsername: "@x", flickrUrl: null, youtubeUrl: null, audioUrl: null };
      await post(term("new-tag", { displayName: "Original", sortOrder: 4, social: own })).expect(201);
      const res = await post(term("new-tag", { displayName: "Replacement", sortOrder: 9, isActive: false }));
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "A tag with the key new-tag already exists: Original.", code: "key-exists" });
      const kept = await request(staffApp).get("/api/terms/tag/new-tag").set(auth(reader));
      expect(kept.body).toMatchObject({ displayName: "Original", sortOrder: 4, isActive: true, social: own });
      expect(await eventsFor("new-tag")).toHaveLength(1);
    });

    it("POST answers 400 for a bad key or name, an unknown field, or a kind that differs from the path; 403 for non-admins", async () => {
      expect((await post(term("New-Tag"))).body).toEqual({ error: "key-format" });
      expect((await post(term("blank-tag", { displayName: " " }))).body).toEqual({ error: "name-required" });
      expect((await post(term("new-tag", { extra: 1 }))).status).toBe(400);
      expect((await post(term("new-tag", { kind: "sector" }))).status).toBe(400);
      expect((await post(term("nope"), () => reader)).status).toBe(403);
      expect((await post(term("nope"), () => siteEditor)).status).toBe(403);
    });

    it("PUT by a non-Core.Admin answers 403", async () => {
      expect((await put("nope", term("nope"), () => reader)).status).toBe(403);
      expect((await put("nope", term("nope"), () => siteEditor)).status).toBe(403);
    });
  });

  it("hides internal error details on unexpected failures", async () => {
    const spy = vi
      .spyOn(organizationsService, "upsertOrganization")
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "organizations_pkey"'));
    try {
      const res = await request(app)
        .put("/api/organizations/boom")
        .set("authorization", `Bearer ${admin}`)
        .send({ ...healthOrg, key: "boom", abbreviation: null });
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
    const pad = MAX_EVENT_BYTES - JSON.stringify({ ...healthOrg, key: "edge", abbreviation: null }).length - 20;
    const edge = { ...healthOrg, key: "edge", abbreviation: null, minister: { ...healthOrg.minister, detailsHtml: "x".repeat(pad) } };
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
      .send({ ...healthOrg, key: "local-login", abbreviation: null });
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

  // TRUST_PROXY_HOPS: behind a DMZ proxy + IIS (two hops) the client is the second-from-right
  // X-Forwarded-For entry; with the default of one hop it is the last (the DMZ server).
  it("trustProxyHops picks which X-Forwarded-For entry is the client", async () => {
    const secret = "w".repeat(40) + "-trust-proxy-hops";
    const passwordHash = await hashPassword("trust-proxy-pass");
    const build = (trustProxyHops?: number) =>
      createApp({ db: tdb.db, subscribers: [], auth: { local: { secret } }, loginRouter: localLoginRouter({ username: "admin", passwordHash, secret }), trustProxyHops });
    const attempt = (a: ReturnType<typeof build>, xff: string) => request(a).post("/auth/local/token").set("X-Forwarded-For", xff).send({ username: "admin", password: "wrong" });
    // Two hops: the client (203.0.113.7) is keyed even though the DMZ hop (10.0.0.5) is shared.
    const two = build(2);
    for (let i = 0; i < 10; i++) expect((await attempt(two, "203.0.113.7, 10.0.0.5")).status).toBe(401);
    expect((await attempt(two, "203.0.113.7, 10.0.0.5")).status).toBe(429);
    expect((await attempt(two, "203.0.113.8, 10.0.0.5")).status).toBe(401); // another visitor, same DMZ hop
    // One hop (default): the DMZ address is the "client", so a different visitor shares the exhausted budget.
    const one = build();
    for (let i = 0; i < 10; i++) await attempt(one, "203.0.113.7, 10.0.0.9");
    expect((await attempt(one, "203.0.113.8, 10.0.0.9")).status).toBe(429);
  });

  describe("POST /api/organizations", () => {
    const create = (token: string, body: unknown) => request(app).post("/api/organizations").set(auth(token)).send(body as object);

    it("creates a ministry and derives its key", async () => {
      const res = await create(admin, { displayName: "Mining and Critical Minerals", minister: { name: "Honourable A B" } });
      expect(res.status).toBe(201);
      expect(res.body.key).toBe("mining-and-critical-minerals");
      const got = await request(app).get("/api/organizations/mining-and-critical-minerals").set(auth(reader)).expect(200);
      expect(got.body.isPublic).toBe(true);
      expect(got.body.isActive).toBe(true);
      expect(got.body.minister.name).toBe("Honourable A B");
      const [row] = await tdb.db.select().from(organizations).where(eq(organizations.key, "mining-and-critical-minerals"));
      expect(row!.staffEditedAt).toBeInstanceOf(Date);
    });

    it("409s a duplicate name", async () => {
      expect((await create(admin, { displayName: "Francophone Affairs Secretariat" })).status).toBe(201);
      const res = await create(admin, { displayName: "Francophone Affairs Secretariat" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "exists", key: "francophone-affairs-secretariat" });
    });

    it("is Core.Admin only", async () => {
      expect((await create(siteEditor, { displayName: "Energy Transition" })).status).toBe(403);
    });

    it("400s a name with no letters or digits", async () => {
      expect((await create(admin, { displayName: "!!!" })).status).toBe(400);
    });

    it("stores an optional abbreviation upper-case; a taken one is 409 abbreviation-taken naming its holder; a malformed one 400", async () => {
      const res = await create(admin, { displayName: "Water Stewardship", abbreviation: "wls" });
      expect(res.status).toBe(201);
      expect(res.body.abbreviation).toBe("WLS");
      const taken = await create(admin, { displayName: "Water Again", abbreviation: "WLS" });
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ error: "abbreviation-taken", takenBy: "Water Stewardship" });
      const bad = await create(admin, { displayName: "Water Third", abbreviation: "W" });
      expect(bad.status).toBe(400);
      expect(bad.body.issues[0].message).toBe("Use 2 to 10 capital letters or digits, e.g. HLTH.");
    });
  });

  describe("PUT /api/organizations/:key abbreviation check (N11)", () => {
    // Own keys and abbreviations: this file shares one database.
    const putOrg = (key: string, over: Record<string, unknown>, query = "") =>
      request(app).put(`/api/organizations/${key}${query}`).set(auth(admin)).send({ ...healthOrg, key, displayName: key, ...over });

    it("refuses an abbreviation another active organization holds, case- and space-insensitively", async () => {
      await putOrg("put-abbr-a", { abbreviation: "PUTA" }).expect(200);
      const res = await putOrg("put-abbr-b", { abbreviation: " puta " });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "abbreviation-taken", takenBy: "put-abbr-a" });
      expect((await request(app).get("/api/organizations/put-abbr-b").set(auth(reader))).status).toBe(404);
      // An inactive holder frees it (N11), and an inactive organization may keep a taken one.
      await putOrg("put-abbr-c", { abbreviation: "PUTA", isActive: false }).expect(200);
    });

    it("refuses reactivating an organization whose abbreviation a successor has taken, even with overwriteStaffEdits", async () => {
      await putOrg("put-react-a", { abbreviation: "PUTR", isActive: false }).expect(200);
      await putOrg("put-react-b", { abbreviation: "PUTR" }).expect(200);
      const res = await putOrg("put-react-a", { abbreviation: "PUTR" }, "?overwriteStaffEdits=true");
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "abbreviation-taken", takenBy: "put-react-b" });
      expect((await request(app).get("/api/organizations/put-react-a").set(auth(reader))).body.isActive).toBe(false);
    });

    it("re-sending an organization that already shares a legacy duplicate is not refused", async () => {
      await putOrg("put-dup-a", { abbreviation: "PUTD" }).expect(200);
      // The importer path (no route check) may still write a legacy duplicate.
      await organizationsService.upsertOrganization(tdb.db, { ...healthOrg, key: "put-dup-b", displayName: "put-dup-b", abbreviation: "PUTD" }, []);
      await putOrg("put-dup-a", { abbreviation: "PUTD", sortOrder: 2 }).expect(200);
    });
  });

  it("PUT 409s a staff-edited organization unless overwriteStaffEdits=true", async () => {
    const key = "labour-staff-edit";
    const org = { ...healthOrg, key, displayName: "Labour", abbreviation: null };
    await request(app).put(`/api/organizations/${key}`).set(auth(admin)).send(org).expect(200);
    await request(app).patch(`/api/organizations/${key}/profile`).set(auth(siteEditor)).send({ displayName: "Labour and Skills" }).expect(200);
    const blocked = await request(app).put(`/api/organizations/${key}`).set(auth(admin)).send(org);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({ error: "staff-edited" });
    expect((await request(app).get(`/api/organizations/${key}`).set(auth(reader))).body.displayName).toBe("Labour and Skills");
    await request(app).put(`/api/organizations/${key}?overwriteStaffEdits=true`).set(auth(admin)).send(org).expect(200);
    expect((await request(app).get(`/api/organizations/${key}`).set(auth(reader))).body.displayName).toBe("Labour");
  });

  describe("PATCH /api/organizations/:key/profile", () => {
    // Own key: this file shares one database and other tests PUT healthOrg repeatedly.
    // One key per test: a staff-edited organization must never be PUT again (it will 409 later).
    const seed = async (key: string) => void (await request(app).put(`/api/organizations/${key}`).set(auth(admin)).send({ ...healthOrg, key, displayName: "Forests", abbreviation: null }).expect(200));
    const get = async (key: string) => (await request(app).get(`/api/organizations/${key}`).set(auth(reader)).expect(200)).body;
    const patch = (token: string, body: unknown, key: string) => request(app).patch(`/api/organizations/${key}/profile`).set(auth(token)).send(body as object);

    it("renames and updates the minister for a SiteEditor", async () => {
      await seed("forests-rename");
      const res = await patch(siteEditor, { displayName: "Health and Wellness", minister: { name: "Honourable Pat Doe" } }, "forests-rename");
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe("Health and Wellness");
      expect(res.body.minister.name).toBe("Honourable Pat Doe");
      const [row] = await tdb.db.select().from(organizations).where(eq(organizations.key, "forests-rename"));
      expect(row!.staffEditedAt).toBeInstanceOf(Date);
    });

    it("preserves fields the form doesn't send", async () => {
      await seed("forests-preserve");
      const before = await get("forests-preserve");
      await patch(siteEditor, { minister: { name: "X" } }, "forests-preserve").expect(200);
      const after = await get("forests-preserve");
      expect(after.minister.name).toBe("X");
      expect({ ...after, minister: { ...after.minister, name: before.minister.name }, updatedAt: before.updatedAt }).toEqual(before);
    });

    it("answers a validation failure with error and an issues array", async () => {
      await seed("forests-issues");
      const res = await patch(siteEditor, { minister: { email: "not-an-email" } }, "forests-issues");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid request");
      expect(Array.isArray(res.body.issues)).toBe(true);
      expect(res.body.issues[0].message).toEqual(expect.any(String));
    });

    it("trims text and rejects a blank name", async () => {
      await seed("forests-trim");
      const res = await patch(siteEditor, { displayName: "  Health  " }, "forests-trim");
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe("Health");
      expect((await patch(siteEditor, { displayName: "   " }, "forests-trim")).status).toBe(400);
    });

    it("forbids admin-only fields for a SiteEditor", async () => {
      await seed("forests-forbid");
      const before = await get("forests-forbid");
      for (const body of [{ isActive: false }, { parentKey: null }, { isHq: true }, { isPublic: false }]) {
        expect((await patch(siteEditor, body, "forests-forbid")).status).toBe(403);
        expect(await get("forests-forbid")).toEqual(before);
      }
      expect((await patch(admin, { isActive: false }, "forests-forbid")).status).toBe(200);
      expect((await get("forests-forbid")).isActive).toBe(false);
    });

    it("403 for NRMS.Editor, 404 for an unknown key, 400 for an unknown field", async () => {
      await seed("forests-roles");
      expect((await patch(editorOnly, { displayName: "X" }, "forests-roles")).status).toBe(403);
      expect((await patch(admin, { displayName: "X" }, "nope")).status).toBe(404);
      expect((await patch(admin, { colour: "red" }, "forests-roles")).status).toBe(400);
    });

    it("clears the minister biography with detailsHtml null, keeping the other minister fields", async () => {
      await seed("forests-bio");
      await patch(siteEditor, { minister: { detailsHtml: null } }, "forests-bio").expect(200);
      const before = await get("forests-bio");
      expect(before.minister.detailsHtml).toBeNull();
      expect(before.minister.name).toBe(healthOrg.minister.name);
      expect(before.minister.address).toBe(healthOrg.minister.address);
      const res = await patch(siteEditor, { minister: { name: "Y", detailsHtml: null } }, "forests-bio");
      expect(res.status).toBe(200);
      expect(res.body.minister.name).toBe("Y");
      expect(res.body.minister.detailsHtml).toBeNull();
    });

    it("clears a stored biography with null or an empty paragraph", async () => {
      await seed("forests-bio2");
      expect((await get("forests-bio2")).minister.detailsHtml).toBeTruthy();
      await patch(siteEditor, { minister: { detailsHtml: "<p></p>" } }, "forests-bio2").expect(200);
      expect((await get("forests-bio2")).minister.detailsHtml).toBeNull();
      await patch(siteEditor, { minister: { detailsHtml: "<p>x</p>" } }, "forests-bio2").expect(200);
      await patch(siteEditor, { minister: { detailsHtml: null } }, "forests-bio2").expect(200);
      expect((await get("forests-bio2")).minister.detailsHtml).toBeNull();
    });

    it("NRMS.SiteEditor may PATCH detailsHtml, teamLinks and both contacts; Core.Admin-only fields stay refused for it", async () => {
      await seed("forests-t1t2");
      const contact = { fullName: "Jo Media", phoneNumber: "250 555-0199", mobileNumber: null, emailAddress: "jo.media@gov.bc.ca" };
      const body = {
        minister: { detailsHtml: '<p>Bio <img src="https://x/y.jpg"><script>alert(1)</script></p>' },
        teamLinks: [{ text: "Premier", url: "/office-of-the-premier/biography" }],
        contact,
        secondContact: { ...contact, fullName: "Second" },
        weekendContactNumber: "250 555-0100",
      };
      const res = await patch(siteEditor, body, "forests-t1t2");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ...body, minister: { detailsHtml: "<p>Bio </p>", name: healthOrg.minister.name } });
      expect(await get("forests-t1t2")).toMatchObject({ teamLinks: body.teamLinks, contact, weekendContactNumber: "250 555-0100" });
      const bad = await patch(siteEditor, { teamLinks: [{ text: "x", url: "javascript:alert(1)" }] }, "forests-t1t2");
      expect(bad.status).toBe(400);
      expect(bad.body.issues[0]).toMatchObject({ path: ["teamLinks", 0, "url"] });
      const before = await get("forests-t1t2");
      for (const extra of [{ isActive: false }, { parentKey: null }, { abbreviation: "FRST" }, { isHq: true }, { isPublic: false }]) {
        expect((await patch(siteEditor, { teamLinks: [], ...extra }, "forests-t1t2")).status).toBe(403);
      }
      expect(await get("forests-t1t2")).toEqual(before);
    });

    it("NRMS.SiteEditor may PATCH displayAdditionalName; '' clears it; 101 characters is 400", async () => {
      await seed("forests-addname");
      const set = await patch(siteEditor, { displayAdditionalName: " (Child Care) " }, "forests-addname");
      expect(set.status).toBe(200);
      expect(set.body.displayAdditionalName).toBe("(Child Care)");
      expect((await get("forests-addname")).displayAdditionalName).toBe("(Child Care)");
      const long = await patch(siteEditor, { displayAdditionalName: "x".repeat(101) }, "forests-addname");
      expect(long.status).toBe(400);
      expect(long.body.issues[0]).toMatchObject({ path: ["displayAdditionalName"], message: "Keep it to 100 characters or fewer." });
      const cleared = await patch(siteEditor, { displayAdditionalName: "" }, "forests-addname");
      expect(cleared.status).toBe(200);
      expect(cleared.body.displayAdditionalName).toBeNull();
    });

    it("a SiteEditor sets the side-column links; topicLinks replace the list in order", async () => {
      await seed("forests-links");
      const topicLinks = [
        { text: "Wildfire", url: "https://www2.gov.bc.ca/wildfire" },
        { text: "Contact", url: "/contact" },
      ];
      const body = { url: "https://gov.bc.ca/forests", topicLinks, serviceLinks: [{ text: "Permits", url: "https://permits.gov.bc.ca" }], social: { flickrUrl: "https://flickr.com/x", youtubeUrl: "https://youtube.com/x" } };
      const res = await patch(siteEditor, body, "forests-links");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ...body, social: { ...body.social, twitterUsername: healthOrg.social.twitterUsername, audioUrl: null } });
      const reordered = await patch(siteEditor, { topicLinks: [topicLinks[1], topicLinks[0]] }, "forests-links");
      expect(reordered.body.topicLinks).toEqual([topicLinks[1], topicLinks[0]]);
    });

    it("an http topic link is 400 invalid request with issues; 21 links is 400", async () => {
      await seed("forests-badlinks");
      const res = await patch(siteEditor, { topicLinks: [{ text: "x", url: "http://x.ca" }] }, "forests-badlinks");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid request");
      expect(res.body.issues[0]).toMatchObject({ path: ["topicLinks", 0, "url"], message: "Must start with https:// or / (a page on this site)." });
      const many = Array.from({ length: 21 }, (_, i) => ({ text: `L${i}`, url: `/p${i}` }));
      expect((await patch(siteEditor, { serviceLinks: many }, "forests-badlinks")).status).toBe(400);
    });

    it("abbreviation: Core.Admin only; stored upper-case; malformed 400; another organization's 409 naming it", async () => {
      await request(app).put("/api/organizations/abbr-a").set(auth(admin)).send({ ...healthOrg, key: "abbr-a", displayName: "Abbr A", abbreviation: "ABBRA" }).expect(200);
      await request(app).put("/api/organizations/abbr-b").set(auth(admin)).send({ ...healthOrg, key: "abbr-b", displayName: "Abbr B", abbreviation: "ABBRB" }).expect(200);
      expect((await patch(siteEditor, { abbreviation: "ABBRC" }, "abbr-b")).status).toBe(403);
      expect((await get("abbr-b")).abbreviation).toBe("ABBRB");
      const set = await patch(admin, { abbreviation: "abbrc" }, "abbr-b");
      expect(set.status).toBe(200);
      expect(set.body.abbreviation).toBe("ABBRC");
      for (const bad of ["H", "HEALTH-1"]) {
        const res = await patch(admin, { abbreviation: bad }, "abbr-b");
        expect(res.status).toBe(400);
        expect(res.body.issues[0].message).toBe("Use 2 to 10 capital letters or digits, e.g. HLTH.");
      }
      const taken = await patch(admin, { abbreviation: "abbra" }, "abbr-b");
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ error: "abbreviation-taken", takenBy: "Abbr A" });
      expect((await get("abbr-b")).abbreviation).toBe("ABBRC");
    });

    it("rejects a non-https photo URL and a bad email", async () => {
      await seed("forests-invalid");
      expect((await patch(siteEditor, { minister: { photoUrl: "http://x/y.jpg" } }, "forests-invalid")).status).toBe(400);
      expect((await patch(siteEditor, { minister: { email: "nope" } }, "forests-invalid")).status).toBe(400);
    });
  });

  describe("ministry succession routes", () => {
    // Own keys: this file shares one database.
    const put = (key: string, displayName: string, abbreviation: string | null) =>
      request(app).put(`/api/organizations/${key}`).set(auth(admin)).send({ ...healthOrg, key, displayName, abbreviation }).expect(200);
    const succeed = (token: string, key: string, body: unknown) => request(app).post(`/api/organizations/${key}/succeed`).set(auth(token)).send(body as object);
    const flags = { moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true };

    it("POST /succeed hands over and answers the record; GET /succession-preview counts first", async () => {
      await put("succ-a", "Succ A", "SUCCA");
      await put("succ-b", "Succ B", null);
      const [u] = await tdb.db.insert(users).values({ email: "succ-staff@example.test", displayName: "Succ Staff" }).returning({ id: users.id });
      const [a] = await tdb.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.key, "succ-a"));
      await tdb.db.insert(userOrganizations).values({ userId: u!.id, organizationId: a!.id });
      const preview = await request(app).get("/api/organizations/succ-a/succession-preview").set(auth(admin));
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({ staff: 1, abbreviation: "SUCCA" });
      const res = await succeed(admin, "succ-a", { successorKeys: ["succ-b"], ...flags });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: "succ-a", isActive: false, successorKeys: ["succ-b"] });
      expect((await request(app).get("/api/organizations/succ-b").set(auth(reader))).body.abbreviation).toBe("SUCCA");
      expect((await request(app).get("/api/organizations/succ-a/succession-preview").set(auth(admin))).body).toEqual({ staff: 0, abbreviation: "SUCCA" });
    });

    it("404 for an unknown ministry, on both routes", async () => {
      await put("succ-404", "Succ 404", null);
      expect((await succeed(admin, "nope", { successorKeys: ["succ-404"], ...flags })).status).toBe(404);
      expect((await request(app).get("/api/organizations/nope/succession-preview").set(auth(admin))).status).toBe(404);
    });

    it("422 with the copy for a refused hand-over; 400 for a malformed body", async () => {
      await put("succ-c", "Succ C", null);
      await put("succ-d", "Succ D", null);
      await tdb.db.update(organizations).set({ successorKeys: ["succ-c"] }).where(eq(organizations.key, "succ-d"));
      const loop = await succeed(admin, "succ-c", { successorKeys: ["succ-d"], ...flags });
      expect(loop.status).toBe(422);
      expect(loop.body).toEqual({ error: "Succ D already leads back to Succ C; that would loop." });
      const self = await succeed(admin, "succ-c", { successorKeys: ["succ-c"], ...flags });
      expect(self.status).toBe(422);
      expect(self.body).toEqual({ error: "A ministry can't succeed itself." });
      expect((await succeed(admin, "succ-c", { successorKeys: [], ...flags })).status).toBe(400);
      expect((await succeed(admin, "succ-c", { successorKeys: ["succ-d"] })).status).toBe(400);
    });

    it("409 abbreviation-taken when another active ministry already holds A's abbreviation", async () => {
      await put("succ-e", "Succ E", "SUCCDUP");
      await put("succ-f", "Succ F", null);
      // PUT now refuses a second active holder; legacy data can still carry one (the importer path writes it).
      await organizationsService.upsertOrganization(tdb.db, { ...healthOrg, key: "succ-g", displayName: "Succ G", abbreviation: "SUCCDUP" }, []);
      const res = await succeed(admin, "succ-e", { successorKeys: ["succ-f"], ...flags });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "abbreviation-taken", takenBy: "Succ G" });
    });

    it("403 for NRMS.SiteEditor", async () => {
      await put("succ-h", "Succ H", null);
      await put("succ-i", "Succ I", null);
      expect((await succeed(siteEditor, "succ-h", { successorKeys: ["succ-i"], ...flags })).status).toBe(403);
      expect((await request(app).get("/api/organizations/succ-h/succession-preview").set(auth(siteEditor))).status).toBe(403);
      expect((await request(app).get("/api/organizations/succ-h").set(auth(reader))).body.isActive).toBe(true);
    });

    it("reactivating through PATCH clears successorKeys", async () => {
      await put("succ-j", "Succ J", null);
      await put("succ-k", "Succ K", null);
      await succeed(admin, "succ-j", { successorKeys: ["succ-k"], ...flags }).expect(200);
      const res = await request(app).patch("/api/organizations/succ-j/profile").set(auth(admin)).send({ isActive: true });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ isActive: true, successorKeys: [] });
    });
  });

  describe("manual review routes", () => {
    const HASH = "c".repeat(64);
    beforeEach(async () => {
      await tdb.pool.query("TRUNCATE manual_reviews");
    });

    it("401 without a token; 403 for anyone but Core.Admin", async () => {
      expect((await request(app).get("/api/manual-reviews")).status).toBe(401);
      for (const token of [reader, siteEditor, directoryService]) {
        expect((await request(app).get("/api/manual-reviews").set(auth(token))).status).toBe(403);
        expect((await request(app).post("/api/manual-reviews").set(auth(token)).send({ pageId: "x", hash: HASH })).status).toBe(403);
      }
      expect((await request(app).get("/api/manual-reviews").set(auth(admin))).body).toEqual([]);
    });

    it("400 for unknown fields and for a malformed page id or hash", async () => {
      const post = (body: unknown) => request(app).post("/api/manual-reviews").set(auth(admin)).send(body as object);
      expect((await post({ pageId: "x", hash: HASH, reviewedBy: "Eve" })).status).toBe(400);
      expect((await post({ pageId: "X", hash: HASH })).status).toBe(400);
      expect((await post({ pageId: "x", hash: "abc" })).status).toBe(400);
      expect((await post({ pageId: "x" })).status).toBe(400);
      expect((await request(app).get("/api/manual-reviews").set(auth(admin))).body).toEqual([]);
    });

    it("records a review (201), idempotently, and lists it with who and when", async () => {
      const post = () => request(app).post("/api/manual-reviews").set(auth(admin)).send({ pageId: "government-terms", hash: HASH });
      expect((await post()).status).toBe(201);
      expect((await post()).status).toBe(201);
      const list = await request(app).get("/api/manual-reviews").set(auth(admin));
      expect(list.status).toBe(200);
      expect(list.body).toEqual([{ pageId: "government-terms", hash: HASH, reviewedBy: "svc", reviewedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }]);
    });
  });

  describe("cabinet change routes (new-government spec §5)", () => {
    const put = (key: string, displayName: string, abbreviation: string | null) =>
      request(app).put(`/api/organizations/${key}`).set(auth(admin)).send({ ...healthOrg, key, displayName, abbreviation }).expect(200);
    const moves = { moveSubscribers: true, moveStaff: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: false };

    it("403 for anyone but Core.Admin", async () => {
      expect((await request(app).get("/api/cabinet-change").set(auth(siteEditor))).status).toBe(403);
      expect((await request(app).put("/api/cabinet-change").set(auth(siteEditor)).send({ operations: [] })).status).toBe(403);
      for (const path of ["preview", "publish", "schedule", "cancel"]) {
        expect((await request(app).post(`/api/cabinet-change/${path}`).set(auth(siteEditor)).send({})).status).toBe(403);
      }
    });

    it("draft, preview, schedule, cancel, then a stale and a clean publish", async () => {
      expect((await request(app).get("/api/cabinet-change").set(auth(admin))).status).toBe(404);
      expect((await request(app).post("/api/cabinet-change/publish").set(auth(admin))).status).toBe(404);
      await put("cab-a", "Cab A", null);
      const a = (await request(app).get("/api/organizations/cab-a").set(auth(reader))).body as { updatedAt: string };
      const rename = { op: "update", key: "cab-a", expectedUpdatedAt: a.updatedAt, patch: { displayName: "Cab A Renamed" } };

      expect((await request(app).put("/api/cabinet-change").set(auth(admin)).send({ operations: [{ op: "update", key: "cab-a" }] })).status).toBe(400);
      const saved = await request(app).put("/api/cabinet-change").set(auth(admin)).send({ operations: [rename] });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ status: "draft", operations: [rename], createdBy: "svc", scheduledFor: null });
      expect((await request(app).get("/api/cabinet-change").set(auth(admin))).body.id).toBe(saved.body.id);

      const preview = await request(app).post("/api/cabinet-change/preview").set(auth(admin));
      expect(preview.status).toBe(200);
      expect(preview.body.problems).toEqual([]);
      expect(preview.body.diff).toEqual([{ key: "cab-a", displayName: "Cab A Renamed", kind: "changed", field: "displayName", from: "Cab A", to: "Cab A Renamed" }]);

      expect((await request(app).post("/api/cabinet-change/schedule").set(auth(admin)).send({ at: "2001-01-01T00:00:00Z" })).body).toEqual({ result: "past", error: "Choose a time in the future." });
      expect((await request(app).post("/api/cabinet-change/schedule").set(auth(admin)).send({ at: "soon" })).status).toBe(400);
      const scheduled = await request(app).post("/api/cabinet-change/schedule").set(auth(admin)).send({ at: "2099-11-20T08:00:00Z" });
      expect(scheduled.status).toBe(200);
      expect(scheduled.body).toMatchObject({ status: "scheduled", scheduledFor: "2099-11-20T08:00:00.000Z", scheduledForLocal: "2099-11-20T01:00" });
      // NG-R15: the Hub sends BC wall-clock time; Core converts it (BC stays on UTC−7 all year after 2026-11-01).
      const local = await request(app).post("/api/cabinet-change/schedule").set(auth(admin)).send({ scheduledForLocal: "2099-11-20T11:00" });
      expect(local.status).toBe(200);
      expect(local.body).toMatchObject({ status: "scheduled", scheduledFor: "2099-11-20T18:00:00.000Z", scheduledForLocal: "2099-11-20T11:00" });
      expect((await request(app).get("/api/cabinet-change").set(auth(admin))).body.scheduledForLocal).toBe("2099-11-20T11:00");
      expect((await request(app).post("/api/cabinet-change/schedule").set(auth(admin)).send({ scheduledForLocal: "2099-02-30T11:00" })).status).toBe(400);
      expect((await request(app).post("/api/cabinet-change/schedule").set(auth(admin)).send({ scheduledForLocal: "2099-11-20T11:00", at: "2099-11-20T08:00:00Z" })).status).toBe(400);
      expect((await request(app).post("/api/cabinet-change/schedule").set(auth(admin)).send({ scheduledForLocal: "2001-01-01T00:00" })).body).toEqual({ result: "past", error: "Choose a time in the future." });

      expect((await request(app).post("/api/cabinet-change/cancel").set(auth(admin))).status).toBe(204);
      expect((await request(app).get("/api/cabinet-change").set(auth(admin))).status).toBe(404);

      // A new draft; Cab A changes underneath it.
      await request(app).put("/api/cabinet-change").set(auth(admin)).send({ operations: [rename, { op: "succeed", key: "cab-a", expectedUpdatedAt: a.updatedAt, successors: [], moves }] }).expect(200);
      const invalid = await request(app).post("/api/cabinet-change/publish").set(auth(admin));
      expect(invalid.status).toBe(422);
      expect(invalid.body).toEqual({ result: "invalid", problems: [{ op: 1, message: "Choose a successor for Cab A, or choose “No successor (abolish it)”." }] });
      await new Promise((r) => setTimeout(r, 5));
      await request(app).patch("/api/organizations/cab-a/profile").set(auth(admin)).send({ sortOrder: 5 }).expect(200);
      const stale = await request(app).post("/api/cabinet-change/publish").set(auth(admin));
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ result: "stale", key: "cab-a" });

      const fresh = (await request(app).get("/api/organizations/cab-a").set(auth(reader))).body as { updatedAt: string };
      await request(app).put("/api/cabinet-change").set(auth(admin)).send({ operations: [{ ...rename, expectedUpdatedAt: fresh.updatedAt }] }).expect(200);
      const published = await request(app).post("/api/cabinet-change/publish").set(auth(admin));
      expect(published.status).toBe(200);
      expect(published.body).toEqual({ result: "published" });
      expect((await request(app).get("/api/organizations/cab-a").set(auth(reader))).body.displayName).toBe("Cab A Renamed");
      expect((await request(app).get("/api/cabinet-change").set(auth(admin))).status).toBe(404);
    });
  });

  it("never returns legacy extras from the organization read API", async () => {
    const { key: _k, ...rest } = healthOrg;
    await organizationsService.upsertOrganization(tdb.db, { ...rest, key: "extras-org" }, [], { legacyExtras: { miscHtml: "<script>secret-misc</script>", audioEmbedHtml: "<audio></audio>" } });
    const [row] = await tdb.db.select().from(organizations).where(eq(organizations.key, "extras-org"));
    expect(row!.legacyExtras).toMatchObject({ miscHtml: "<script>secret-misc</script>" });
    for (const path of ["/api/organizations", "/api/organizations/extras-org"]) {
      const res = await request(app).get(path).set(auth(admin));
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/legacyExtras|legacy_extras|miscHtml|miscRightHtml|EmbedHtml|secret-misc/);
    }
  });
});
