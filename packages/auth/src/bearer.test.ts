import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { requireBearer, requireRole } from "./bearer";

const issuer = "https://login.microsoftonline.com/tenant/v2.0";
const audience = "api://core";
let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;

async function token(claims: Record<string, unknown>, opts: { aud?: string; exp?: string | number } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(opts.aud ?? audience)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

describe("requireBearer / requireRole", () => {
  let app: express.Express;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    keys = createLocalJWKSet({ keys: [jwk] });
    app = express();
    app.get("/read", requireBearer({ issuer, audience, keys }), (req, res) => res.json(req.auth));
    app.get("/admin", requireBearer({ issuer, audience, keys }), requireRole("Core.Admin"), (_req, res) => res.json({ ok: true }));
  });

  it("401 without a token", async () => {
    expect((await request(app).get("/read")).status).toBe(401);
  });

  it("401 for wrong audience or expired token", async () => {
    expect((await request(app).get("/read").set("authorization", `Bearer ${await token({}, { aud: "api://other" })}`)).status).toBe(401);
    expect((await request(app).get("/read").set("authorization", `Bearer ${await token({}, { exp: Math.floor(Date.now() / 1000) - 60 })}`)).status).toBe(401);
  });

  it("exposes subject and roles", async () => {
    const res = await request(app).get("/read").set("authorization", `Bearer ${await token({ roles: ["Core.Admin"] })}`);
    expect(res.body).toMatchObject({ subject: "user-1", roles: ["Core.Admin"] });
  });

  it("403 when the role is missing", async () => {
    const res = await request(app).get("/admin").set("authorization", `Bearer ${await token({ roles: ["Core.Read"] })}`);
    expect(res.status).toBe(403);
  });

  it("401 (not 500) for a malformed token that isn't even a JWT", async () => {
    const res = await request(app).get("/read").set("authorization", "Bearer not-a-jwt-at-all");
    expect(res.status).toBe(401);
  });

  it("401 for a token signed with a different algorithm (HS256)", async () => {
    const hsToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("some-arbitrary-secret-value"));
    const res = await request(app).get("/read").set("authorization", `Bearer ${hsToken}`);
    expect(res.status).toBe(401);
  });
});
