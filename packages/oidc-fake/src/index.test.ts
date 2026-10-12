import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeOidc, type FakeOidc } from "./index";

const TENANT = "0000fa4e-0000-4000-8000-000000000001";
const REDIRECT = "https://hub.example.test/core/auth/entra/callback";
const BASE = "https://hub.example.test/fake-entra";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let fake: FakeOidc;
let app: express.Express;

beforeEach(async () => {
  fake = await createFakeOidc({
    tenantId: TENANT,
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUris: [REDIRECT],
    serverBase: BASE,
    browserBase: BASE,
    identities: [{ key: "staff", oid: "oid-staff", email: "pat.example@example.test", name: "Pat Example" }],
  });
  app = express();
  app.use("/fake-entra", fake.router);
});

const authQuery = (over: Record<string, string> = {}) =>
  new URLSearchParams({ client_id: "client-1", redirect_uri: REDIRECT, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st-1", nonce: "n-1", scope: "openid profile email", ...over }).toString();

async function approve(over: Record<string, string> = {}): Promise<URL> {
  const res = await request(app).get(`/fake-entra/${TENANT}/oauth2/v2.0/authorize/approve?${authQuery(over)}&user=staff`);
  expect(res.status).toBe(302);
  return new URL(res.headers.location!);
}

const token = (code: string, over: Record<string, string> = {}) =>
  request(app)
    .post(`/fake-entra/${TENANT}/oauth2/v2.0/token`)
    .type("form")
    .send({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: "client-1", client_secret: "secret-1", ...over });

describe("fake Entra", () => {
  it("serves discovery with the browser authorize URL and the server token and JWKS URLs", async () => {
    const res = await request(app).get(`/fake-entra/${TENANT}/v2.0/.well-known/openid-configuration`);
    expect(res.body).toMatchObject({
      issuer: `${BASE}/${TENANT}/v2.0`,
      authorization_endpoint: `${BASE}/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: `${BASE}/${TENANT}/oauth2/v2.0/token`,
      jwks_uri: `${BASE}/${TENANT}/discovery/v2.0/keys`,
    });
    expect(fake.issuer).toBe(`${BASE}/${TENANT}/v2.0`);
  });

  it("answers 404 for another tenant", async () => {
    expect((await request(app).get("/fake-entra/other/v2.0/.well-known/openid-configuration")).status).toBe(404);
  });

  it("lists the test identities on the authorize page, escaped", async () => {
    const res = await request(app).get(`/fake-entra/${TENANT}/oauth2/v2.0/authorize?${authQuery()}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Pat Example (pat.example@example.test)");
    expect(res.text).toContain('href="authorize/approve?');
    expect(res.text).toContain('href="authorize/cancel?');
  });

  it.each([
    ["an unknown client", { client_id: "other" }],
    ["an unregistered redirect URI", { redirect_uri: "https://evil.example.test/cb" }],
    ["no PKCE challenge", { code_challenge: "" }],
    ["plain PKCE", { code_challenge_method: "plain" }],
    ["no nonce", { nonce: "" }],
  ])("refuses an authorize request with %s", async (_label, over) => {
    expect((await request(app).get(`/fake-entra/${TENANT}/oauth2/v2.0/authorize?${authQuery(over)}`)).status).toBe(400);
  });

  it("approve returns to the redirect URI with a code and the state; cancel with access_denied", async () => {
    const back = await approve();
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("code")).toBeTruthy();
    const cancel = await request(app).get(`/fake-entra/${TENANT}/oauth2/v2.0/authorize/cancel?${authQuery()}`);
    const to = new URL(cancel.headers.location!);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st-1");
  });

  it("issues an RS256 ID token, verifiable with the published JWKS, with the Entra claims", async () => {
    const code = (await approve()).searchParams.get("code")!;
    const res = await token(code);
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe("Bearer");
    const jwks = (await request(app).get(`/fake-entra/${TENANT}/discovery/v2.0/keys`)).body;
    const { payload, protectedHeader } = await jwtVerify(res.body.id_token, createLocalJWKSet(jwks), { issuer: fake.issuer, audience: "client-1" });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload).toMatchObject({ oid: "oid-staff", tid: TENANT, nonce: "n-1", preferred_username: "pat.example@example.test", name: "Pat Example" });
  });

  it("codes are single use", async () => {
    const code = (await approve()).searchParams.get("code")!;
    expect((await token(code)).status).toBe(200);
    expect((await token(code)).body).toEqual({ error: "invalid_grant" });
  });

  it.each([
    ["a wrong PKCE verifier", { code_verifier: "w".repeat(43) }],
    ["no PKCE verifier", { code_verifier: "" }],
    ["another redirect URI", { redirect_uri: "https://hub.example.test/other" }],
  ])("refuses a token request with %s", async (_label, over) => {
    const code = (await approve()).searchParams.get("code")!;
    expect((await token(code, over)).body).toEqual({ error: "invalid_grant" });
  });

  it("refuses a wrong client secret with invalid_client", async () => {
    const code = (await approve()).searchParams.get("code")!;
    const res = await token(code, { client_secret: "nope" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_client" });
  });

  it("applies token overrides to the next token only", async () => {
    fake.controls.setNextTokenOverrides({ tid: "other-tenant", aud: "other-client", nonce: "other-nonce" });
    const first = decodeJwt((await token((await approve()).searchParams.get("code")!)).body.id_token);
    expect(first).toMatchObject({ tid: "other-tenant", aud: "other-client", nonce: "other-nonce" });
    const second = decodeJwt((await token((await approve()).searchParams.get("code")!)).body.id_token);
    expect(second).toMatchObject({ tid: TENANT, aud: "client-1", nonce: "n-1" });
  });

  it("applies an exp override, and can omit the oid claim", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    fake.controls.setNextTokenOverrides({ exp });
    const withExp = decodeJwt((await token((await approve()).searchParams.get("code")!)).body.id_token);
    expect(withExp.exp).toBe(exp);

    fake.controls.setNextTokenOverrides({ omitOid: true });
    const withoutOid = decodeJwt((await token((await approve()).searchParams.get("code")!)).body.id_token);
    expect(withoutOid.oid).toBeUndefined();
  });

  // A test site's fake is reachable by anyone, unauthenticated and with no rate limit — an
  // unredeemed code must not grow the pending-code map without bound. 1001 approvals (one
  // past the cap) must evict only the single oldest, never the most recent.
  it("caps the number of pending codes, dropping only the oldest once the cap is reached", async () => {
    const issued: string[] = [];
    for (let i = 0; i < 1001; i++) {
      issued.push((await approve()).searchParams.get("code")!);
    }
    expect((await token(issued[0]!)).body).toEqual({ error: "invalid_grant" });
    expect((await token(issued[issued.length - 1]!)).status).toBe(200);
  }, 30_000);

  it("can sign with a key the JWKS doesn't publish", async () => {
    fake.controls.setNextTokenOverrides({ signWithUnpublishedKey: true });
    const idToken = (await token((await approve()).searchParams.get("code")!)).body.id_token;
    const jwks = (await request(app).get(`/fake-entra/${TENANT}/discovery/v2.0/keys`)).body;
    await expect(jwtVerify(idToken, createLocalJWKSet(jwks))).rejects.toThrow();
  });
});
