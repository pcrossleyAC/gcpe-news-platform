import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { createApp } from "../app";

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

  it("republish returns the number of enqueued events", async () => {
    const res = await request(app).post("/api/admin/republish").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(202);
    expect(res.body.enqueued).toBe(2);
  });
});
