import express from "express";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { requireBearer, requireRole } from "./bearer";
import { ADMIN_ROLES, LOCAL_AUDIENCE, LOCAL_ISSUER, localLoginRouter, mintLocalToken } from "./local";
import { hashPassword } from "./password";

const secret = "a".repeat(32) + "-local-test-secret";
const entra = { issuer: "https://login.microsoftonline.com/t/v2.0", audience: "api://core" };

function appWith(opts: Parameters<typeof requireBearer>[0], login?: express.Router) {
  const app = express();
  if (login) app.use(login);
  app.get("/api/x", requireBearer(opts), requireRole("Core.Admin"), (req, res) => void res.json({ sub: req.auth!.subject }));
  return app;
}

describe("local admin auth", () => {
  let passwordHash: string;
  let rsa: Awaited<ReturnType<typeof generateKeyPair>>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  beforeAll(async () => {
    passwordHash = await hashPassword("s3cret-pass");
    rsa = await generateKeyPair("RS256");
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(rsa.publicKey)), kid: "k", alg: "RS256" }] });
  });

  it("logs in and the token works on the API", async () => {
    const login = localLoginRouter({ username: "admin", passwordHash, secret });
    const app = appWith({ ...entra, keys, local: { secret } }, login);
    const res = await request(app).post("/auth/local/token").send({ username: "admin", password: "s3cret-pass" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 28800 });
    const api = await request(app).get("/api/x").set("authorization", `Bearer ${res.body.access_token}`);
    expect(api.body).toEqual({ sub: "admin" });
  });

  it("gives the same 401 for a wrong username and a wrong password", async () => {
    const app = appWith({ local: { secret } }, localLoginRouter({ username: "admin", passwordHash, secret }));
    const a = await request(app).post("/auth/local/token").send({ username: "nobody", password: "s3cret-pass" });
    const b = await request(app).post("/auth/local/token").send({ username: "admin", password: "nope" });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
  });

  it("rate-limits login attempts", async () => {
    const app = appWith({ local: { secret } }, localLoginRouter({ username: "admin", passwordHash, secret }));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await request(app).post("/auth/local/token").send({ username: "admin", password: "x" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rejects a login body over the 1kb limit with 413", async () => {
    const app = appWith({ local: { secret } }, localLoginRouter({ username: "admin", passwordHash, secret }));
    const res = await request(app)
      .post("/auth/local/token")
      .send({ username: "admin", password: "x".repeat(2000) });
    expect(res.status).toBe(413);
  });

  it("rejects a correctly signed local token when local auth is disabled", async () => {
    const token = await mintLocalToken({ secret, subject: "admin", roles: [...ADMIN_ROLES] });
    const res = await request(appWith({ ...entra, keys })).get("/api/x").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects algorithm/issuer confusion in both directions", async () => {
    const app = appWith({ ...entra, keys, local: { secret } });
    const rsWithLocalIss = await new SignJWT({ roles: ["Core.Admin"] }).setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(LOCAL_ISSUER).setAudience(LOCAL_AUDIENCE).setSubject("x").setExpirationTime("5m").sign(rsa.privateKey);
    const hsWithEntraIss = await new SignJWT({ roles: ["Core.Admin"] }).setProtectedHeader({ alg: "HS256" })
      .setIssuer(entra.issuer).setAudience(entra.audience).setSubject("x").setExpirationTime("5m").sign(new TextEncoder().encode(secret));
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${rsWithLocalIss}`)).status).toBe(401);
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${hsWithEntraIss}`)).status).toBe(401);
  });

  it("rejects a local token signed with a different secret, and an expired one", async () => {
    const app = appWith({ local: { secret } });
    const wrong = await mintLocalToken({ secret: "b".repeat(40), subject: "admin", roles: [...ADMIN_ROLES] });
    const expired = await mintLocalToken({ secret, subject: "admin", roles: [...ADMIN_ROLES], ttlSeconds: -10 });
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${wrong}`)).status).toBe(401);
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${expired}`)).status).toBe(401);
  });

  it("still accepts Entra RS256 tokens alongside local auth", async () => {
    const t = await new SignJWT({ roles: ["Core.Admin"] }).setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(entra.issuer).setAudience(entra.audience).setSubject("svc").setExpirationTime("5m").sign(rsa.privateKey);
    expect((await request(appWith({ ...entra, keys, local: { secret } })).get("/api/x").set("authorization", `Bearer ${t}`)).body).toEqual({ sub: "svc" });
  });
});
