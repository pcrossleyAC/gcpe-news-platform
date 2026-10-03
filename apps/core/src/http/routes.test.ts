import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
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

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(issuer).setAudience(audience).setSubject("svc").setExpirationTime("5m").sign(pair.privateKey);
    admin = await sign(["Core.Admin"]);
    reader = await sign([]);
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
    expect(malformed.status).toBe(401);
    const huge = await request(app)
      .put("/api/organizations/health")
      .set("content-type", "application/json")
      .send(JSON.stringify({ pad: "x".repeat(MAX_EVENT_BYTES * 2) }));
    expect(huge.status).toBe(401);
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

  it("republish returns the number of enqueued events", async () => {
    const res = await request(app).post("/api/admin/republish").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(202);
    expect(res.body.enqueued).toBe(2);
  });
});
