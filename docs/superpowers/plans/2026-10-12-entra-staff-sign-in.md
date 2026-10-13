# Entra Staff Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff sign in to the staff web app with their government Microsoft account (Entra OIDC, authorization code with a real PKCE verifier), matched to an existing Core user and issued the same `gcpe_session` cookie as password sign-in. Local sign-in stays for test sites.

**Architecture:** Core gains an `entra_oid` column, a matcher (by `oid`, then by email, linking in one transaction), and two public routes, `GET /core/auth/entra` and `GET /core/auth/entra/callback`, built on `openid-client` 6.8.8. The state, nonce, PKCE verifier and return path ride in an HMAC-signed `gcpe_entra` cookie, so any replica can finish the flow. A new `packages/oidc-fake` stands in for Microsoft in tests and, when explicitly enabled, on test sites, reached in-process by Core through the stack's existing `self:` internal fetch.

**Tech Stack:** Node 24, TypeScript, Express 5, drizzle-orm/drizzle-kit, Postgres, `openid-client` 6.8.8 (exact), `jose` 6, React 19 + `@bcgov/design-system-react-components`, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-entra-staff-sign-in-design.md` (approved by Paul, 2026-10-12). Read it with this plan.

## Global Constraints

- Node 24 (`node -v` → `v24.x`). Install `node_modules` under Node 24 too: under Node 20, vitest fails to load rolldown's native binding.
- Migrations via drizzle-kit only (`npm --workspace @gcpe/core run db:generate -- --name <name>`). Never hand-write SQL or snapshots.
- No debug logging. Logs carry `safeErrorLabel` plus the route, the code and the user id only. Never log tokens, codes, state, emails or names.
- No task or decision labels in code comments (no "Task 3", "D1", "R5", "§4").
- Fictional data only, with `example.test` addresses.
- No `Co-Authored-By` lines in commits. Never commit `CLAUDE.md`.
- v1 News API compatibility suites unchanged: this plan touches no `apps/news-api` file.
- boxs.ca behaviour unchanged when no Entra settings are present: `scripts/siteground-env.ts` is not changed, and a test pins that it emits none.
- `openid-client` pinned exactly at `6.8.8` in `apps/core/package.json`.
- Error codes and messages are exactly the spec's §6 table.

## Rulings (planner's, against the spec and the code at HEAD 04814f1)

1. **Pinned `openid-client` 6.8.8**, the current v6 (npm, 2026-10-12). Dry-run against the fake: `discovery`, `buildAuthorizationUrl` (adds `client_id` and `response_type=code`), `authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected })`, and `tokens.claims()` all behave as this plan uses them.
2. **openid-client checks neither `tid` nor, by default, the ID token signature.** Both were verified in a dry run: a wrong-tenant token and a token signed by an unpublished key were both accepted. Core checks `tid` itself and calls `enableNonRepudiationChecks(config)`, which makes the unpublished-key token fail. Tests pin both checks, and both tests fail if either line is removed (also verified).
3. **openid-client sends `redirect_uri` as `currentUrl` without its query.** So Core builds `currentUrl` from the configured redirect URI plus the callback's query, never from the request's host.
4. **"Partial configuration"** means any of `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` or `PUBLIC_BASE_URL` set without all of them plus `ENTRA_TENANT_ID` and `SESSION_SECRET`. `ENTRA_TENANT_ID` alone stays legitimate, because service-to-service bearer tokens use it, and leaves sign-in off.
5. **Stack names are prefixed:** `CORE_ENTRA_CLIENT_ID`, `CORE_ENTRA_CLIENT_SECRET`, `CORE_PUBLIC_BASE_URL` and `CORE_LOCAL_PASSWORDS_ALLOWED`. Core reads them unprefixed from its env view. The spec writes `PUBLIC_BASE_URL` and `LOCAL_PASSWORDS_ALLOWED` bare. They are Core-only, so they take Core's prefix like every other Core setting. `ENTRA_TENANT_ID` stays shared.
6. **There is no `apps/core/src/env.ts`.** Core's env schema lives in `start.ts`. The sign-in settings live in `apps/core/src/entra/config.ts` (`signInSettingsFromEnv`), which `startCore` and `checkStack` both call, so startup and `--check` fail identically.
7. **`GET /core/auth/methods`** returns `local: userPasswordsAllowed || breakGlassConfigured`, so production break-glass still gets the password form. "Production" means `NODE_ENV=production`, the same test `authFromEnv` uses.
8. **DB invariant (beyond the spec):** the check `users_entra_link_check` enforces `(sign_in_method = 'entra') = (entra_oid IS NOT NULL)`. Dry-run: the migration applies on a fresh DB, and all 161 Core tests at HEAD still pass. No code writes `'entra'` today.
9. **`setPassword` refuses a linked user** (409 "this user signs in with Microsoft; unlink them first"). At HEAD it silently flipped `sign_in_method` to `local`, which would leave the `oid` behind (and now violate the check above).
10. **"Audited the same way":** Core has no audit table. User changes are audited by the aggregate lock, the transaction and a `user.upserted` event. Unlink does all three. Linking at sign-in locks and runs in one transaction but emits nothing, because no `UserRecord` field changes.
11. **Linking keeps `password_hash`.** Password sign-in is refused while the user is linked and works again after an unlink.
12. **Email match order:** a user already linked to a different `oid` returns `conflict` before an inactive user returns `inactive`. Two first sign-ins at once both succeed. Two different `oid`s racing for one email give one link and one `conflict`. Tests pin both cases.
13. **`gcpe_entra` uses `Secure` when `SESSION_COOKIE_SECURE` does**, the same as `gcpe_session`. The default is true. Its HMAC key is `HMAC(SESSION_SECRET, "gcpe-entra-state")`, not the raw secret.
14. **The fake is opt-in:** `FAKE_ENTRA_ENABLED=true`. It is refused on a real production deployment and alongside any real Entra setting. It injects `ENTRA_TENANT_ID` and `AUTH_AUDIENCE` into Core's view only, because `authFromEnv` needs that pair, plus a test-only `ENTRA_AUTHORITY_URL=self:/fake-entra/<tid>/v2.0`. Core refuses `ENTRA_AUTHORITY_URL` in real production. Core reaches the fake in-process. The browser reaches its picker under `CORE_PUBLIC_BASE_URL`. A dry run with the stack's `installInternalFetch` completed discovery, token and JWKS calls.
15. **The "Sign in with Microsoft" control is a link, not a button.** It navigates. It also keeps `getByRole("button", { name: "Sign in" })` in `sign-in-roles.spec.ts` unambiguous, because Playwright's name match is a substring match.
16. **Rate limit:** 30 a minute per IP on each Entra route (`entraRatePerMinute` overrides it for tests). Failure redirects drop the return path.
17. **Log severity:** `failed` and `conflict` go to `console.error`, which the stack's error log captures. The other refusals go to `console.warn`.
18. **No host canonicalisation:** a sign-in started on a host other than `CORE_PUBLIC_BASE_URL`'s ends `expired`. This is documented in the runbook.
19. **"Andre's heads-up section 3" isn't in the repo.** The runbook's new section carries the settings and the exact redirect URI instead.

## Review Focus

1. **Coming back to the callback twice** (browser Back, a refresh, a double click): the state cookie is already cleared and the code is spent, so the user should see `expired` and get no session and no 500. Owner: Task 3, test "refuses as expired: no state cookie…". The fake's single-use codes are pinned in Task 1.
2. **Emails that differ only in case or whitespace** between Entra's `preferred_username` and Core should still match. Owner: Task 2, test "compares a stored mixed-case email case-insensitively". Task 3's fake identity is `Staff.Person@…` against a Core user `staff.person@…`.
3. **A crafted `returnTo`** (absolute, protocol-relative, backslash, dot segments, encoded dots, control characters, too long) should land on `/hub/`. Owner: Task 3, `return-to.test.ts`.
4. **Two sign-ins at once:** the same person in two tabs, or two Entra accounts claiming one email. The first should link once and both should sign in. The second should give exactly one `conflict`. Owner: Task 2, the two concurrency tests.
5. **Entra unreachable or discovery down** should return `failed`, set no state cookie, and retry discovery on the next attempt. Owner: Task 3, test "a discovery failure…".

## File map

| File | Task | Responsibility |
|---|---|---|
| `packages/oidc-fake/{package.json,src/index.ts,src/index.test.ts}` | 1 | Fake Entra v2.0: discovery, JWKS, picker, token with PKCE, RS256 ID tokens, one-shot token overrides |
| `apps/core/src/db/schema.ts`, `apps/core/migrations/0004_entra_oid.sql` (+ meta) | 2 | `entra_oid`, unique index, link check |
| `apps/core/src/services/users.ts` | 2 | `matchEntraUser`, `unlinkEntra`, `UserLinkedToEntraError`, `authenticate(..., { usersAllowed })`, `setPassword` guard |
| `apps/core/src/http/users.ts` | 2 | `POST /api/users/:id/unlink-entra`, 409 mapping |
| `apps/core/src/entra/config.ts` | 3 | `signInSettingsFromEnv`: on/off, partial-config errors, production password rule |
| `apps/core/src/entra/state-cookie.ts` | 3 | Seal and open `gcpe_entra` |
| `apps/core/src/entra/return-to.ts` | 3 | `safeHubReturnTo` |
| `apps/core/src/entra/client.ts` | 3 | openid-client wrapper: cached discovery, auth URL, exchange, `tid`/`oid` checks |
| `apps/core/src/entra/routes.ts` | 3 | `GET /auth/entra`, `GET /auth/entra/callback`, refusal logging |
| `apps/core/src/http/session-cookie.ts` | 3 | `newSessionCookie`, shared by password and Entra sign-in |
| `apps/core/src/http/session.ts`, `app.ts`, `start.ts`, `apps/stack/src/stack.ts` (`checkStack`) | 3 | Wiring, `/auth/methods`, password rule, `--check` |
| `apps/staff-web/src/screens/SignIn.tsx`, `styles/global.css`, `screens/admin/users/UsersScreen.tsx` | 4 | Microsoft link, error messages, unlink button |
| `apps/stack/src/env.ts`, `apps/stack/src/stack.ts` (mount), `apps/stack/package.json` | 5 | Fake wiring and guards |
| `tests/e2e/{global-setup.ts,entra-sign-in.spec.ts}`, `tests/siteground-env.test.ts` | 5 | End-to-end, boxs.ca pin |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md` | 5 | C210, Q89, running notes, runbook |

Order: 1 → 2 → 3 → 4 → 5. Task 3 consumes 1 and 2. Task 4 consumes only Task 3's HTTP contract. Task 5 consumes all.

---
### Task 1: Fake Entra identity provider (`packages/oidc-fake`) — **lighter review**

**Files:**
- Create: `packages/oidc-fake/package.json`
- Create: `packages/oidc-fake/src/index.ts`
- Test: `packages/oidc-fake/src/index.test.ts`
- Modify: `package-lock.json` (via `npm install`)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 3 and 5):
  - `createFakeOidc(o: FakeOidcOptions): Promise<FakeOidc>`
  - `FakeOidcOptions = { tenantId; clientId; clientSecret; redirectUris: string[]; serverBase: string; browserBase: string; identities: FakeOidcIdentity[] }`. `serverBase` and `browserBase` include the mount path, e.g. `http://stack.internal/fake-entra`.
  - `FakeOidcIdentity = { key; oid; email; name }`
  - `FakeOidc = { router: Router; issuer: string /* `${serverBase}/${tenantId}/v2.0` */; controls: { setNextTokenOverrides(o: FakeOidcTokenOverrides): void } }`
  - `FakeOidcTokenOverrides = { tid?; aud?; nonce?; iss?; signWithUnpublishedKey?: boolean }`, applied to the next token only.
  - Paths relative to the mount: `/<tid>/v2.0/.well-known/openid-configuration`, `/<tid>/discovery/v2.0/keys`, `/<tid>/oauth2/v2.0/authorize` (an HTML picker with links `authorize/approve?…&user=<key>` and `authorize/cancel?…`), `/<tid>/oauth2/v2.0/token`.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@gcpe/oidc-fake",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "express": "^5.2.1", "jose": "^6.1.3" },
  "devDependencies": { "@types/express": "^5.0.6", "supertest": "^7.1.0", "@types/supertest": "^7.2.1" }
}
```

Run: `npm install` (from the repo root, Node 24). Expected: `package-lock.json` gains `packages/oidc-fake` and `node_modules/@gcpe/oidc-fake`.

- [ ] **Step 2: Write the failing tests**

```ts
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

  it("can sign with a key the JWKS doesn't publish", async () => {
    fake.controls.setNextTokenOverrides({ signWithUnpublishedKey: true });
    const idToken = (await token((await approve()).searchParams.get("code")!)).body.id_token;
    const jwks = (await request(app).get(`/fake-entra/${TENANT}/discovery/v2.0/keys`)).body;
    await expect(jwtVerify(idToken, createLocalJWKSet(jwks))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/oidc-fake`
Expected: FAIL. `Failed to resolve import "./index"` (or `Cannot find module`).

- [ ] **Step 4: Write the fake**

```ts
import { createHash, randomBytes } from "node:crypto";
import express, { type Router } from "express";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

/**
 * A fake Microsoft Entra ID (v2.0) for tests and test sites: discovery, JWKS, an authorize page
 * that lists fixed test identities, and a token endpoint that checks the client secret, the
 * redirect URI and the PKCE verifier (S256), then returns an RS256 ID token. Mounted by the stack
 * only when FAKE_ENTRA_ENABLED=true on a non-production deployment, never in production. Every
 * identity is made up and uses example.test addresses.
 *
 * Paths mirror Microsoft's, relative to the mount point: `/<tenant>/v2.0/.well-known/openid-configuration`,
 * `/<tenant>/discovery/v2.0/keys`, `/<tenant>/oauth2/v2.0/authorize` and `/<tenant>/oauth2/v2.0/token`.
 */

export interface FakeOidcIdentity {
  /** Picker key, used in the approve link. */
  key: string;
  oid: string;
  email: string;
  name: string;
}

/** Applied to the next ID token only, then cleared: lets a test send a token from the wrong
 * tenant, for the wrong audience, with the wrong nonce or issuer, or signed by a key the JWKS
 * doesn't publish. */
export interface FakeOidcTokenOverrides {
  tid?: string;
  aud?: string;
  nonce?: string;
  iss?: string;
  signWithUnpublishedKey?: boolean;
}

export interface FakeOidcOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The only redirect URIs the authorize and token endpoints accept. */
  redirectUris: string[];
  /** Where the client reaches the fake server-to-server (issuer, token, JWKS), mount path included. */
  serverBase: string;
  /** Where the browser reaches the authorize page, mount path included. */
  browserBase: string;
  identities: FakeOidcIdentity[];
}

export interface FakeOidc {
  router: Router;
  issuer: string;
  controls: { setNextTokenOverrides(overrides: FakeOidcTokenOverrides): void };
}

interface PendingCode {
  identity: FakeOidcIdentity;
  redirectUri: string;
  challenge: string;
  nonce: string;
  expiresAt: number;
}

const CODE_TTL_MS = 60_000;
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const s256 = (v: string): string => createHash("sha256").update(v).digest("base64url");
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function createFakeOidc(o: FakeOidcOptions): Promise<FakeOidc> {
  const signing = await generateKeyPair("RS256");
  const unpublished: CryptoKey = (await generateKeyPair("RS256")).privateKey;
  const kid = randomBytes(8).toString("hex");
  const jwk = { ...(await exportJWK(signing.publicKey)), kid, alg: "RS256", use: "sig" };
  const issuer = `${o.serverBase}/${o.tenantId}/v2.0`;
  const codes = new Map<string, PendingCode>();
  let overrides: FakeOidcTokenOverrides = {};

  const authRequest = (q: Record<string, unknown>) => {
    const ok =
      str(q.client_id) === o.clientId &&
      o.redirectUris.includes(str(q.redirect_uri)) &&
      str(q.response_type) === "code" &&
      str(q.code_challenge_method) === "S256" &&
      str(q.code_challenge) !== "" &&
      str(q.state) !== "" &&
      str(q.nonce) !== "";
    return ok ? { redirectUri: str(q.redirect_uri), state: str(q.state), nonce: str(q.nonce), challenge: str(q.code_challenge) } : null;
  };
  const backTo = (redirectUri: string, params: Record<string, string>): string => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.href;
  };

  const r = express.Router();
  r.use("/:tenant", (req, res, next) => (req.params.tenant === o.tenantId ? next() : void res.status(404).json({ error: "unknown tenant" })));

  r.get("/:tenant/v2.0/.well-known/openid-configuration", (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${o.browserBase}/${o.tenantId}/oauth2/v2.0/authorize`,
      token_endpoint: `${o.serverBase}/${o.tenantId}/oauth2/v2.0/token`,
      jwks_uri: `${o.serverBase}/${o.tenantId}/discovery/v2.0/keys`,
      response_types_supported: ["code"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  r.get("/:tenant/discovery/v2.0/keys", (_req, res) => void res.json({ keys: [jwk] }));

  r.get("/:tenant/oauth2/v2.0/authorize", (req, res) => {
    if (!authRequest(req.query as Record<string, unknown>)) return void res.status(400).type("text/plain").send("invalid authorization request");
    const qs = escapeHtml(new URLSearchParams(req.query as Record<string, string>).toString());
    const items = o.identities
      .map((i) => `<li><a href="authorize/approve?${qs}&amp;user=${encodeURIComponent(i.key)}">${escapeHtml(i.name)} (${escapeHtml(i.email)})</a></li>`)
      .join("");
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake Microsoft sign-in</title></head><body><main>` +
          `<h1>Fake Microsoft sign-in</h1><p>Test sites only. Choose a test identity.</p><ul>${items}</ul>` +
          `<p><a href="authorize/cancel?${qs}">Cancel</a></p></main></body></html>`,
      );
  });

  r.get("/:tenant/oauth2/v2.0/authorize/approve", (req, res) => {
    const a = authRequest(req.query as Record<string, unknown>);
    const identity = o.identities.find((i) => i.key === req.query.user);
    if (!a || !identity) return void res.status(400).type("text/plain").send("invalid authorization request");
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { identity, redirectUri: a.redirectUri, challenge: a.challenge, nonce: a.nonce, expiresAt: Date.now() + CODE_TTL_MS });
    res.redirect(302, backTo(a.redirectUri, { code, state: a.state }));
  });

  r.get("/:tenant/oauth2/v2.0/authorize/cancel", (req, res) => {
    const a = authRequest(req.query as Record<string, unknown>);
    if (!a) return void res.status(400).type("text/plain").send("invalid authorization request");
    res.redirect(302, backTo(a.redirectUri, { error: "access_denied", state: a.state }));
  });

  r.post("/:tenant/oauth2/v2.0/token", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (str(b.client_id) !== o.clientId || str(b.client_secret) !== o.clientSecret) return void res.status(401).json({ error: "invalid_client" });
    const code = str(b.code);
    const pending = codes.get(code);
    codes.delete(code); // single use, even when the rest of the request is wrong
    const verifier = str(b.code_verifier);
    if (str(b.grant_type) !== "authorization_code" || !pending || pending.expiresAt < Date.now() || pending.redirectUri !== str(b.redirect_uri) || !verifier || s256(verifier) !== pending.challenge) {
      return void res.status(400).json({ error: "invalid_grant" });
    }
    const t = overrides;
    overrides = {};
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      oid: pending.identity.oid,
      tid: t.tid ?? o.tenantId,
      nonce: t.nonce ?? pending.nonce,
      preferred_username: pending.identity.email,
      email: pending.identity.email,
      name: pending.identity.name,
      ver: "2.0",
    })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(t.iss ?? issuer)
      .setAudience(t.aud ?? o.clientId)
      .setSubject(s256(`${o.clientId}:${pending.identity.oid}`))
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(t.signWithUnpublishedKey ? unpublished : signing.privateKey);
    res.set("cache-control", "no-store").json({ token_type: "Bearer", access_token: randomBytes(24).toString("base64url"), expires_in: 3600, scope: "openid profile email", id_token: idToken });
  });

  return {
    router: r,
    issuer,
    controls: {
      setNextTokenOverrides(next) {
        overrides = { ...next };
      },
    },
  };
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run packages/oidc-fake && npx tsc -p tsconfig.json`
Expected: 17 tests pass. `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/oidc-fake package-lock.json
git commit -m "feat(oidc-fake): fake Entra v2.0 provider for tests and test sites"
```

---
### Task 2: Entra identity on Core users: column, matching, password refusal, unlink — **full review**

**Files:**
- Modify: `apps/core/src/db/schema.ts` (the `users` table)
- Create (generated): `apps/core/migrations/0004_entra_oid.sql`, `apps/core/migrations/meta/0004_snapshot.json`. Modify (generated): `apps/core/migrations/meta/_journal.json`
- Modify: `apps/core/src/services/users.ts`
- Modify: `apps/core/src/http/users.ts`
- Test: `apps/core/src/services/entra-users.test.ts` (new)
- Test: `apps/core/src/http/users.test.ts` (one new test, one import)

**Interfaces:**
- Consumes: `lockUser`, `sessionUserFor`, `emitUserUpserted` and `getUser`, already in `services/users.ts`.
- Produces (used by Task 3):
  - `matchEntraUser(db: Db, oid: string, email: string | null): Promise<EntraMatch>`. Pass `email` already trimmed and lowercased, or null.
  - `type EntraRefusal = "not_provisioned" | "inactive" | "conflict"`
  - `type EntraMatch = { ok: true; user: SessionUser } | { ok: false; code: EntraRefusal; userId?: string }`
  - `authenticate(db, address, pw, opts?: { usersAllowed?: boolean })`. `usersAllowed: false` refuses every users-row password. A user with `signInMethod === "entra"` is always refused. Both refusals still cost one scrypt verification.
  - `unlinkEntra(db, id, subscribers): Promise<UserView>`. Throws `UserNotFoundError`.
  - `class UserLinkedToEntraError extends Error`, thrown by `setPassword` for a linked user.
  - HTTP (used by Task 4): `POST /core/api/users/:id/unlink-entra` (Core.Admin, CSRF header) → 200 `UserView`, 404 when the user is unknown. `POST /core/api/users/:id/password` → 409 `{ "error": "this user signs in with Microsoft; unlink them first" }` for a linked user.
  - `UserView` is unchanged (`signInMethod: "local" | "entra"`; the oid is never exposed).

- [ ] **Step 1: Write the failing service tests**

Create `apps/core/src/services/entra-users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { users } from "../db/schema";
import { authenticate, createUser, createUserSchema, getUser, matchEntraUser, setPassword, unlinkEntra, updateUser, UserLinkedToEntraError } from "./users";

const PW = "a long enough password";

describe("Entra identities on Core users", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const make = async (email: string | null, opts: { roles?: string[]; isActive?: boolean; password?: string } = {}) =>
    createUser(tdb.db, createUserSchema.parse({ email, displayName: `User ${email ?? "no email"}`, roles: opts.roles ?? [], isActive: opts.isActive ?? true, password: opts.password }), []);
  const row = async (id: string) => (await tdb.db.select().from(users).where(eq(users.id, id)))[0]!;

  it("matches by email the first time, links the oid in the same step, then matches by oid", async () => {
    const u = await make("first.match@example.test", { roles: ["NRMS.Editor"] });
    const first = await matchEntraUser(tdb.db, "oid-first", "first.match@example.test");
    expect(first).toEqual({ ok: true, user: { id: u.id, name: u.displayName, email: "first.match@example.test", roles: ["NRMS.Editor"] } });
    expect(await row(u.id)).toMatchObject({ entraOid: "oid-first", signInMethod: "entra" });
    // The email in the token can change later; the oid still finds the user.
    expect(await matchEntraUser(tdb.db, "oid-first", "renamed@example.test")).toMatchObject({ ok: true, user: { id: u.id } });
  });

  it("compares a stored mixed-case email case-insensitively", async () => {
    const [mixed] = await tdb.db.insert(users).values({ email: "Mixed.Case@example.test", displayName: "Mixed Case" }).returning();
    expect(await matchEntraUser(tdb.db, "oid-mixed", "mixed.case@example.test")).toMatchObject({ ok: true, user: { id: mixed!.id } });
  });

  it("refuses an identity with no matching user as not_provisioned, and creates nothing", async () => {
    const before = (await tdb.db.select().from(users)).length;
    expect(await matchEntraUser(tdb.db, "oid-nobody", "nobody@example.test")).toEqual({ ok: false, code: "not_provisioned" });
    expect((await tdb.db.select().from(users)).length).toBe(before);
  });

  it("never matches a user whose email is NULL", async () => {
    const [noEmail] = await tdb.db.insert(users).values({ email: null, displayName: "No Email", isActive: false }).returning();
    expect(await matchEntraUser(tdb.db, "oid-no-email", null)).toEqual({ ok: false, code: "not_provisioned" });
    expect(await matchEntraUser(tdb.db, "oid-no-email", "")).toEqual({ ok: false, code: "not_provisioned" });
    expect(await row(noEmail!.id)).toMatchObject({ entraOid: null, signInMethod: "local" });
  });

  it("refuses an inactive user as inactive, matched by email or by oid, without linking by email", async () => {
    const idle = await make("idle@example.test", { isActive: false });
    expect(await matchEntraUser(tdb.db, "oid-idle", "idle@example.test")).toEqual({ ok: false, code: "inactive", userId: idle.id });
    expect((await row(idle.id)).entraOid).toBeNull();

    const gone = await make("gone@example.test");
    expect(await matchEntraUser(tdb.db, "oid-gone", "gone@example.test")).toMatchObject({ ok: true });
    await updateUser(tdb.db, gone.id, { isActive: false }, []);
    expect(await matchEntraUser(tdb.db, "oid-gone", "gone@example.test")).toEqual({ ok: false, code: "inactive", userId: gone.id });
  });

  it("refuses as conflict when the email's user is linked to a different oid, and changes nothing", async () => {
    const taken = await make("taken@example.test");
    expect(await matchEntraUser(tdb.db, "oid-original", "taken@example.test")).toMatchObject({ ok: true });
    expect(await matchEntraUser(tdb.db, "oid-impostor", "taken@example.test")).toEqual({ ok: false, code: "conflict", userId: taken.id });
    expect((await row(taken.id)).entraOid).toBe("oid-original");
  });

  it("two first sign-ins at once for the same identity both succeed and link once", async () => {
    const u = await make("twice@example.test");
    const [a, b] = await Promise.all([matchEntraUser(tdb.db, "oid-twice", "twice@example.test"), matchEntraUser(tdb.db, "oid-twice", "twice@example.test")]);
    expect(a).toMatchObject({ ok: true, user: { id: u.id } });
    expect(b).toMatchObject({ ok: true, user: { id: u.id } });
    expect((await row(u.id)).entraOid).toBe("oid-twice");
  });

  it("two different identities racing for one email: one links, the other is a conflict", async () => {
    const u = await make("raced@example.test");
    const results = await Promise.all([matchEntraUser(tdb.db, "oid-race-a", "raced@example.test"), matchEntraUser(tdb.db, "oid-race-b", "raced@example.test")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "conflict", userId: u.id }]);
  });

  it("a linked user is refused at password sign-in like a wrong password", async () => {
    const both = await make("both@example.test", { password: PW });
    expect(await authenticate(tdb.db, "both@example.test", PW)).not.toBeNull();
    await matchEntraUser(tdb.db, "oid-both", "both@example.test");
    expect(await authenticate(tdb.db, "both@example.test", PW)).toBeNull();
  });

  it("usersAllowed: false refuses every user's password", async () => {
    await make("plain@example.test", { password: PW });
    expect(await authenticate(tdb.db, "plain@example.test", PW, { usersAllowed: false })).toBeNull();
    expect(await authenticate(tdb.db, "plain@example.test", PW, { usersAllowed: true })).not.toBeNull();
  });

  it("won't set a password on a linked user; unlink returns them to local sign-in", async () => {
    const linked = await make("linked@example.test");
    await matchEntraUser(tdb.db, "oid-linked", "linked@example.test");
    await expect(setPassword(tdb.db, linked.id, PW)).rejects.toBeInstanceOf(UserLinkedToEntraError);

    const view = await unlinkEntra(tdb.db, linked.id, []);
    expect(view.signInMethod).toBe("local");
    expect(await row(linked.id)).toMatchObject({ entraOid: null, signInMethod: "local" });
    await setPassword(tdb.db, linked.id, PW);
    expect(await authenticate(tdb.db, "linked@example.test", PW)).not.toBeNull();
    // Unlinking an already-local user changes nothing.
    expect((await unlinkEntra(tdb.db, linked.id, [])).signInMethod).toBe("local");
    expect((await getUser(tdb.db, linked.id))!.signInMethod).toBe("local");
  });

  it("the database refuses an Entra sign-in method without an oid, and an oid without it", async () => {
    const u = await make("constraint@example.test");
    await expect(tdb.db.update(users).set({ signInMethod: "entra" }).where(eq(users.id, u.id))).rejects.toMatchObject({ cause: { constraint: "users_entra_link_check" } });
    await expect(tdb.db.update(users).set({ entraOid: "oid-x" }).where(eq(users.id, u.id))).rejects.toMatchObject({ cause: { constraint: "users_entra_link_check" } });
  });
});
```

- [ ] **Step 2: Write the failing API test**

In `apps/core/src/http/users.test.ts`, change the import

```ts
import { createUser, createUserSchema } from "../services/users";
```

to

```ts
import { createUser, createUserSchema, matchEntraUser } from "../services/users";
```

and add this test as the last test inside `describe("Core users API", …)`, just before its closing `});`:

```ts
  it("unlinks Microsoft sign-in (Core.Admin only, emitting user.upserted) and refuses a password while linked", async () => {
    const count = async (aggregateId: string) => (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, aggregateId))).length;
    const staff = await createUser(tdb.db, createUserSchema.parse({ email: "linked.staff@example.test", displayName: "Linked Staff" }), []);
    await matchEntraUser(tdb.db, "oid-linked-staff", "linked.staff@example.test");

    const refused = await as(adminCookie).post(`/api/users/${staff.id}/password`, { password: "a long enough password" });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "this user signs in with Microsoft; unlink them first" });

    expect((await as(viewerCookie).post(`/api/users/${staff.id}/unlink-entra`)).status).toBe(403);
    expect((await request(app).post(`/api/users/${staff.id}/unlink-entra`).set("cookie", adminCookie)).status).toBe(403);
    const before = await count(`user:${staff.id}`);
    const res = await as(adminCookie).post(`/api/users/${staff.id}/unlink-entra`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: staff.id, signInMethod: "local" });
    expect(res.body).not.toHaveProperty("entraOid");
    expect(await count(`user:${staff.id}`)).toBe(before + 1);
    expect((await as(adminCookie).post(`/api/users/${staff.id}/password`, { password: "a long enough password" })).status).toBe(204);
    expect((await as(adminCookie).post("/api/users/00000000-0000-4000-8000-000000000000/unlink-entra")).status).toBe(404);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run apps/core/src/services/entra-users.test.ts apps/core/src/http/users.test.ts`
Expected: FAIL. The new tests error with `matchEntraUser is not a function` (or `unlinkEntra` / `setPassword` assertions), because the exports and the column don't exist yet. Every existing test in `users.test.ts` still passes.

- [ ] **Step 4: Add the column, its index and the link check to the schema**

In `apps/core/src/db/schema.ts`, in the `users` table, add after `passwordHash: text("password_hash"),`:

```ts
    /** The Entra object id (`oid`) this user signs in as, once linked. Set together with sign_in_method 'entra'. */
    entraOid: text("entra_oid"),
```

and in the table's constraint list add after `uniqueIndex("users_email_lower_idx")…,`:

```ts
    uniqueIndex("users_entra_oid_idx").on(t.entraOid),
```

and after `check("users_active_needs_email", …),`:

```ts
    // Linked to Entra exactly when signing in with Entra: a linked user never has a usable password.
    check("users_entra_link_check", sql`(${t.signInMethod} = 'entra') = (${t.entraOid} IS NOT NULL)`),
```

- [ ] **Step 5: Generate the migration with drizzle-kit**

Run: `npm --workspace @gcpe/core run db:generate -- --name entra_oid`
Expected: creates `apps/core/migrations/0004_entra_oid.sql` with exactly this content (verified by a dry run at HEAD):

```sql
ALTER TABLE "users" ADD COLUMN "entra_oid" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid_idx" ON "users" USING btree ("entra_oid");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_entra_link_check" CHECK (("users"."sign_in_method" = 'entra') = ("users"."entra_oid" IS NOT NULL));
```

It also creates `meta/0004_snapshot.json` and adds one entry to `meta/_journal.json`. If the SQL differs (for example, extra statements from drift), stop and report: don't edit the SQL by hand.

- [ ] **Step 6: Implement the service changes**

In `apps/core/src/services/users.ts`:

1. Change the drizzle import to include `isNull`:

```ts
import { and, asc, eq, inArray, isNull, notLike, sql } from "drizzle-orm";
```

2. After `export class UserAlreadyHasEmailError extends Error {}` add:

```ts
/** Setting a password for a user who signs in with Entra: unlink them first. */
export class UserLinkedToEntraError extends Error {}
```

3. Directly before `const isCheckViolation = …` add:

```ts
const isUniqueViolation = (e: unknown, constraint: string) => {
  const cause = (e as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === "23505" && cause.constraint === constraint;
};
```

4. Replace the whole `setPassword` function with:

```ts
export async function setPassword(db: Db, id: string, pw: string): Promise<void> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  const passwordHash = await hashPassword(pw);
  const updated = await db
    .update(users)
    .set({ passwordHash, signInMethod: "local", updatedAt: new Date() })
    .where(and(eq(users.id, id), isNull(users.entraOid)))
    .returning({ id: users.id });
  if (updated.length > 0) return;
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  throw exists ? new UserLinkedToEntraError(id) : new UserNotFoundError(id);
}
```

5. Replace the whole `authenticate` function (keep the `dummyHash` comment and declaration above it) with:

```ts
/**
 * Password sign-in for a users row. `usersAllowed: false` (production with Entra on, unless
 * LOCAL_PASSWORDS_ALLOWED) refuses every user; a user linked to Entra is always refused. Both
 * refusals still cost the one verification and look exactly like a wrong password.
 */
export async function authenticate(db: Db, address: string, pw: string, opts: { usersAllowed?: boolean } = {}): Promise<UserView | null> {
  const [row] = await db.select().from(users).where(sql`lower(${users.email}) = ${address.trim().toLowerCase()}`);
  const stored = row?.passwordHash ?? (await (dummyHash ??= hashPassword("placeholder-never-matches-anything")));
  const ok = await verifyPassword(pw, stored);
  if (!row || !row.isActive || !row.passwordHash || row.signInMethod === "entra" || opts.usersAllowed === false || !ok) return null;
  return getUser(db, row.id);
}
```

6. Append at the end of the file:

```ts
/** Why an Entra identity was refused: the sign-in screen's codes. */
export type EntraRefusal = "not_provisioned" | "inactive" | "conflict";
export type EntraMatch = { ok: true; user: SessionUser } | { ok: false; code: EntraRefusal; userId?: string };

/**
 * Finds the Core user for an Entra identity: by `oid` first, then by email
 * (already trimmed and lowercased; null when the token carried none) among users not yet linked,
 * linking that user in the same transaction. Never creates a user and never matches a user
 * without an email.
 */
export async function matchEntraUser(db: Db, oid: string, email: string | null): Promise<EntraMatch> {
  const [linked] = await db.select({ id: users.id }).from(users).where(eq(users.entraOid, oid));
  if (linked) {
    const user = await sessionUserFor(db, linked.id);
    return user ? { ok: true, user } : { ok: false, code: "inactive", userId: linked.id };
  }
  if (!email) return { ok: false, code: "not_provisioned" };
  const [candidate] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (!candidate) return { ok: false, code: "not_provisioned" };
  let outcome: "linked" | EntraRefusal;
  try {
    outcome = await db.transaction(async (tx) => {
      await lockUser(tx, candidate.id);
      const [row] = await tx
        .select({ id: users.id, email: users.email, isActive: users.isActive, entraOid: users.entraOid })
        .from(users)
        .where(eq(users.id, candidate.id))
        .for("update");
      if (!row || row.email === null || row.email.toLowerCase() !== email) return "not_provisioned";
      if (row.entraOid !== null) return row.entraOid === oid ? "linked" : "conflict";
      if (!row.isActive) return "inactive";
      await tx.update(users).set({ entraOid: oid, signInMethod: "entra", updatedAt: new Date() }).where(eq(users.id, row.id));
      return "linked";
    });
  } catch (e) {
    // Another user took this oid between the lookup above and this write.
    if (isUniqueViolation(e, "users_entra_oid_idx")) return { ok: false, code: "conflict", userId: candidate.id };
    throw e;
  }
  if (outcome === "not_provisioned") return { ok: false, code: outcome };
  if (outcome !== "linked") return { ok: false, code: outcome, userId: candidate.id };
  const user = await sessionUserFor(db, candidate.id);
  return user ? { ok: true, user } : { ok: false, code: "inactive", userId: candidate.id };
}

/** Core.Admin unlink: forgets the user's Entra identity and returns them to
 * local sign-in. The next Entra sign-in matches by email again. */
export async function unlinkEntra(db: Db, id: string, subscribers: SubscriberConfig[]): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  await db.transaction(async (tx) => {
    await lockUser(tx, id);
    const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
    if (!row) throw new UserNotFoundError(id);
    await tx.update(users).set({ entraOid: null, signInMethod: "local", updatedAt: new Date() }).where(eq(users.id, row.id));
    await emitUserUpserted(tx, row.id, subscribers);
  });
  return (await getUser(db, id))!;
}
```

- [ ] **Step 7: Add the unlink route and the 409**

In `apps/core/src/http/users.ts`:

1. Add `unlinkEntra,` to the import list from `../services/users` (after `setRolesSchema,`) and `UserLinkedToEntraError,` (after `UserExistsError,`).
2. In `run`'s error mapping, after the `UserAlreadyHasEmailError` line, add:

```ts
    if (e instanceof UserLinkedToEntraError) return void res.status(409).json({ error: "this user signs in with Microsoft; unlink them first" });
```

3. Before `return r;` at the end of `usersRouter`, add:

```ts
  r.post(
    "/:id/unlink-entra",
    run<IdParams>(async (req, res) => void res.json(await unlinkEntra(db, req.params.id, subscribers))),
  );
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run apps/core/src`
Expected: everything passes (at HEAD: 161 tests; now 161 + 12 + 1).

Run the concurrency tests three times to make sure they are stable: `for i in 1 2 3; do npx vitest run apps/core/src/services/entra-users.test.ts; done`. Expected: 12 pass each time.

- [ ] **Step 9: Type check and commit**

Run: `npx tsc -p tsconfig.json`. Expected: no output.

```bash
git add apps/core/src/db/schema.ts apps/core/migrations apps/core/src/services/users.ts apps/core/src/services/entra-users.test.ts apps/core/src/http/users.ts apps/core/src/http/users.test.ts
git commit -m "feat(core): link Core users to Entra identities; refuse passwords for linked users; admin unlink"
```

---
### Task 3: Entra sign-in flow in Core: config, state cookie, callback, methods, startup and `--check` — **full review**

**Files:**
- Modify: `apps/core/package.json` (`openid-client` exact 6.8.8, devDependency `@gcpe/oidc-fake`), `package-lock.json`
- Create: `apps/core/src/entra/config.ts`, `apps/core/src/entra/state-cookie.ts`, `apps/core/src/entra/return-to.ts`, `apps/core/src/entra/client.ts`, `apps/core/src/entra/routes.ts`
- Create: `apps/core/src/http/session-cookie.ts`
- Modify: `apps/core/src/http/session.ts`, `apps/core/src/app.ts`, `apps/core/src/start.ts`
- Modify: `apps/stack/src/stack.ts` (`checkStack` only)
- Test: `apps/core/src/entra/{config,state-cookie,return-to,routes}.test.ts` (new); `apps/core/src/start.test.ts` and `apps/stack/src/stack-check.test.ts` (new cases)

**Interfaces:**
- Consumes: Task 1's `createFakeOidc` (tests only). Task 2's `matchEntraUser`, `EntraRefusal` and `authenticate(..., { usersAllowed })`.
- Produces:
  - HTTP (used by Task 4): `GET /core/auth/methods` → `{ entra: boolean, local: boolean }`. `GET /core/auth/entra?returnTo=<path under /hub/>` → 302 to Microsoft. `GET /core/auth/entra/callback` → 302 to the return path, or to `/hub/sign-in?error=<cancelled|expired|failed|not_provisioned|inactive|conflict>`.
  - `signInSettingsFromEnv(env): { entra: EntraSignInConfig | null; userPasswordsAllowed: boolean }`, which throws `Entra sign-in is partly configured: missing A, B` (used by Task 5's tests).
  - `EntraSignInConfig = { tenantId; clientId; clientSecret; authority; redirectUri }`
  - Core env view keys: `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `LOCAL_PASSWORDS_ALLOWED`, `ENTRA_AUTHORITY_URL` (test sites only), `SESSION_SECRET`. Task 5 injects these in fake mode.
  - `createApp({ session: { …, entra?: EntraClient | null; userPasswordsAllowed?: boolean; entraRatePerMinute?: number } })`

- [ ] **Step 1: Add the dependencies**

Edit `apps/core/package.json`. In `dependencies`, after `"express-rate-limit"`, add `"openid-client": "6.8.8",`. In `devDependencies`, add `"@gcpe/oidc-fake": "0.0.0",` as the first entry. The version is exact: no `^`. Then run `npm install`.
Expected: `node_modules/openid-client/package.json` has `"version": "6.8.8"`.

- [ ] **Step 2: Write the failing unit tests (config, state cookie, return path)**

Create `apps/core/src/entra/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { signInSettingsFromEnv } from "./config";

const TENANT = "0000fa4e-0000-4000-8000-000000000002";
const FULL = {
  ENTRA_TENANT_ID: TENANT,
  ENTRA_CLIENT_ID: "core-client",
  ENTRA_CLIENT_SECRET: "core-secret",
  PUBLIC_BASE_URL: "https://news.example.test",
  SESSION_SECRET: "s".repeat(32),
};

describe("signInSettingsFromEnv", () => {
  it("is off with none of the settings, and with ENTRA_TENANT_ID alone (service tokens only)", () => {
    expect(signInSettingsFromEnv({})).toEqual({ entra: null, userPasswordsAllowed: true });
    expect(signInSettingsFromEnv({ ENTRA_TENANT_ID: TENANT, NODE_ENV: "production" })).toEqual({ entra: null, userPasswordsAllowed: true });
  });

  it("is on with every setting, using Microsoft's v2.0 authority and the callback under PUBLIC_BASE_URL", () => {
    expect(signInSettingsFromEnv(FULL).entra).toEqual({
      tenantId: TENANT,
      clientId: "core-client",
      clientSecret: "core-secret",
      authority: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      redirectUri: "https://news.example.test/core/auth/entra/callback",
    });
    expect(signInSettingsFromEnv({ ...FULL, PUBLIC_BASE_URL: "https://news.example.test/" }).entra!.redirectUri).toBe("https://news.example.test/core/auth/entra/callback");
  });

  it.each([
    [{ ENTRA_CLIENT_ID: "core-client" }, "missing ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET, PUBLIC_BASE_URL, SESSION_SECRET"],
    [{ ...FULL, ENTRA_CLIENT_SECRET: undefined }, "missing ENTRA_CLIENT_SECRET"],
    [{ ...FULL, PUBLIC_BASE_URL: "" }, "missing PUBLIC_BASE_URL"],
    [{ ...FULL, ENTRA_TENANT_ID: undefined }, "missing ENTRA_TENANT_ID"],
    [{ ...FULL, SESSION_SECRET: undefined }, "missing SESSION_SECRET"],
  ])("a partial configuration fails, naming what's missing (%#)", (env, message) => {
    expect(() => signInSettingsFromEnv(env)).toThrow(`Entra sign-in is partly configured: ${message}`);
  });

  it.each([
    ["not a URL", "news.example.test"],
    ["a path", "https://news.example.test/hub"],
    ["plain http off localhost", "http://news.example.test"],
  ])("refuses a PUBLIC_BASE_URL with %s", (_label, value) => {
    expect(() => signInSettingsFromEnv({ ...FULL, PUBLIC_BASE_URL: value })).toThrow(/PUBLIC_BASE_URL/);
  });

  it("allows http for localhost", () => {
    expect(signInSettingsFromEnv({ ...FULL, PUBLIC_BASE_URL: "http://127.0.0.1:4100" }).entra!.redirectUri).toBe("http://127.0.0.1:4100/core/auth/entra/callback");
  });

  it("production refuses user passwords when Entra is on, unless LOCAL_PASSWORDS_ALLOWED=true", () => {
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production" }).userPasswordsAllowed).toBe(false);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", LOCAL_PASSWORDS_ALLOWED: "false" }).userPasswordsAllowed).toBe(false);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", LOCAL_PASSWORDS_ALLOWED: "true" }).userPasswordsAllowed).toBe(true);
    expect(signInSettingsFromEnv({ NODE_ENV: "production" }).userPasswordsAllowed).toBe(true);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "test" }).userPasswordsAllowed).toBe(true);
    expect(() => signInSettingsFromEnv({ LOCAL_PASSWORDS_ALLOWED: "yes" })).toThrow('LOCAL_PASSWORDS_ALLOWED must be "true" or "false"');
  });

  it("ENTRA_AUTHORITY_URL points a test site at the fake, and is refused in production or on its own", () => {
    const fake = "http://stack.internal/fake-entra/0000fa4e/v2.0";
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "test", ENTRA_AUTHORITY_URL: `${fake}/` }).entra!.authority).toBe(fake);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true", ENTRA_AUTHORITY_URL: fake }).entra!.authority).toBe(fake);
    expect(() => signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", ENTRA_AUTHORITY_URL: fake })).toThrow("ENTRA_AUTHORITY_URL is for test sites only");
    expect(() => signInSettingsFromEnv({ ENTRA_AUTHORITY_URL: fake })).toThrow("ENTRA_AUTHORITY_URL is set but Entra sign-in is not");
  });
});
```

Create `apps/core/src/entra/state-cookie.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clearedEntraStateCookie, entraStateCookie, openEntraState, sealEntraState } from "./state-cookie";

const SECRET = "x".repeat(40);
const VALUE = { state: "st", nonce: "nn", codeVerifier: "cv", returnTo: "/hub/releases/drafts" };

describe("gcpe_entra state cookie", () => {
  it("round-trips within five minutes and expires after", () => {
    const now = Date.UTC(2026, 9, 12, 12, 0, 0);
    const sealed = sealEntraState(SECRET, VALUE, now);
    expect(openEntraState(SECRET, sealed, now + 299_000)).toEqual(VALUE);
    expect(openEntraState(SECRET, sealed, now + 300_000)).toBeNull();
  });

  it("refuses a missing, tampered, re-signed-with-another-secret or malformed value", () => {
    const sealed = sealEntraState(SECRET, VALUE);
    const [body, sig] = sealed.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...VALUE, returnTo: "/hub/other", exp: 9_999_999_999 })).toString("base64url");
    expect(openEntraState(SECRET, undefined)).toBeNull();
    expect(openEntraState(SECRET, `${forged}.${sig}`)).toBeNull();
    expect(openEntraState("y".repeat(40), sealed)).toBeNull();
    expect(openEntraState(SECRET, body)).toBeNull();
    expect(openEntraState(SECRET, `${body}.${sig}.extra`)).toBeNull();
  });

  it("refuses a validly signed value missing a field", () => {
    expect(openEntraState(SECRET, sealEntraState(SECRET, { ...VALUE, codeVerifier: "" }))).toBeNull();
  });

  it("is HttpOnly, SameSite=Lax, scoped to /core/auth/entra, five minutes, Secure when asked", () => {
    expect(entraStateCookie("v", { secure: true })).toBe("gcpe_entra=v; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=300; Secure");
    expect(entraStateCookie("v", { secure: false })).toBe("gcpe_entra=v; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=300");
    expect(clearedEntraStateCookie({ secure: true })).toBe("gcpe_entra=; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });
});
```

Create `apps/core/src/entra/return-to.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { safeHubReturnTo } from "./return-to";

describe("safeHubReturnTo", () => {
  it.each([
    ["/hub/releases/drafts", "/hub/releases/drafts"],
    ["/hub/search?q=fire#top", "/hub/search?q=fire#top"],
    ["/hub", "/hub/"],
    ["/hub/", "/hub/"],
  ])("keeps %s", (value, expected) => {
    expect(safeHubReturnTo(value)).toBe(expected);
  });

  it.each([
    ["missing", undefined],
    ["an array", ["/hub/a", "/hub/b"]],
    ["empty", ""],
    ["relative", "hub/releases"],
    ["protocol-relative", "//evil.example.test/hub/"],
    ["backslash", "/\\evil.example.test"],
    ["absolute", "https://evil.example.test/hub/"],
    ["outside /hub", "/core/api/users"],
    ["a /hub prefix only", "/hubx/releases"],
    ["dot segments leaving /hub", "/hub/../core/api/users"],
    ["encoded dot segments", "/hub/%2e%2e/core"],
    ["a control character", "/hub/\nset-cookie"],
    ["too long", `/hub/${"a".repeat(600)}`],
  ])("refuses %s", (_label, value) => {
    expect(safeHubReturnTo(value)).toBe("/hub/");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run apps/core/src/entra`
Expected: FAIL. The modules `./config`, `./state-cookie` and `./return-to` don't exist.

- [ ] **Step 4: Implement config, state cookie and return path**

Create `apps/core/src/entra/config.ts`:

```ts
/**
 * Core's staff sign-in settings, read from Core's own env view: in the
 * stack these are CORE_ENTRA_CLIENT_ID, CORE_ENTRA_CLIENT_SECRET, CORE_PUBLIC_BASE_URL and
 * CORE_LOCAL_PASSWORDS_ALLOWED, plus the shared ENTRA_TENANT_ID and SESSION_SECRET.
 */
export interface EntraSignInConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Issuer and discovery base: Microsoft's v2.0 endpoint for the tenant, unless a test site points it at the fake. */
  authority: string;
  /** `<PUBLIC_BASE_URL>/core/auth/entra/callback`: the redirect URI registered in Entra. */
  redirectUri: string;
}

export interface SignInSettings {
  entra: EntraSignInConfig | null;
  /** False only in production with Entra on and LOCAL_PASSWORDS_ALLOWED not "true". The break-glass admin is unaffected. */
  userPasswordsAllowed: boolean;
}

export const ENTRA_CALLBACK_PATH = "/core/auth/entra/callback";

const TRIGGERS = ["ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "PUBLIC_BASE_URL"] as const;
const REQUIRED = ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "PUBLIC_BASE_URL", "SESSION_SECRET"] as const;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const set = (env: NodeJS.ProcessEnv, key: string) => typeof env[key] === "string" && env[key] !== "";

function publicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL, e.g. https://news.example.test");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error("PUBLIC_BASE_URL must be an origin only (scheme and host), with no path");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("PUBLIC_BASE_URL must use https (http only for localhost)");
  }
  return url.origin;
}

/**
 * Parses and checks the sign-in settings. Entra sign-in is on when ENTRA_CLIENT_ID,
 * ENTRA_CLIENT_SECRET or PUBLIC_BASE_URL is set; then every one of them, ENTRA_TENANT_ID and
 * SESSION_SECRET must be set too, or this throws naming what's missing. ENTRA_TENANT_ID alone
 * (service-to-service tokens) leaves sign-in off. Throws on any invalid value, so startCore and
 * `stack --check` fail the same way.
 */
export function signInSettingsFromEnv(env: NodeJS.ProcessEnv): SignInSettings {
  const allowed = env.LOCAL_PASSWORDS_ALLOWED;
  if (allowed !== undefined && allowed !== "true" && allowed !== "false") throw new Error('LOCAL_PASSWORDS_ALLOWED must be "true" or "false"');
  const production = env.NODE_ENV === "production";
  const testDeployment = !production || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true";

  if (!TRIGGERS.some((k) => set(env, k))) {
    if (set(env, "ENTRA_AUTHORITY_URL")) throw new Error("ENTRA_AUTHORITY_URL is set but Entra sign-in is not: set ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and PUBLIC_BASE_URL too");
    return { entra: null, userPasswordsAllowed: true };
  }
  const missing = REQUIRED.filter((k) => !set(env, k));
  if (missing.length > 0) throw new Error(`Entra sign-in is partly configured: missing ${missing.join(", ")}`);

  const tenantId = env.ENTRA_TENANT_ID!;
  let authority = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0`;
  if (set(env, "ENTRA_AUTHORITY_URL")) {
    if (!testDeployment) throw new Error("ENTRA_AUTHORITY_URL is for test sites only and is refused in production");
    authority = env.ENTRA_AUTHORITY_URL!.replace(/\/+$/, "");
  }
  return {
    entra: {
      tenantId,
      clientId: env.ENTRA_CLIENT_ID!,
      clientSecret: env.ENTRA_CLIENT_SECRET!,
      authority,
      redirectUri: `${publicOrigin(env.PUBLIC_BASE_URL!)}${ENTRA_CALLBACK_PATH}`,
    },
    userPasswordsAllowed: !production || allowed === "true",
  };
}
```

Create `apps/core/src/entra/state-cookie.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `gcpe_entra` cookie: the state, nonce, PKCE verifier and
 * return path of one sign-in, carried by the browser from GET /core/auth/entra to the callback,
 * so any replica can finish the flow. HMAC-signed with a key derived from SESSION_SECRET, never
 * the secret itself, so it can't be confused with a session token.
 */
export const ENTRA_STATE_COOKIE = "gcpe_entra";
export const ENTRA_STATE_PATH = "/core/auth/entra";
export const ENTRA_STATE_TTL_SECONDS = 5 * 60;

export interface EntraFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

const keyFor = (secret: string) => createHmac("sha256", secret).update("gcpe-entra-state").digest();
const mac = (secret: string, body: string) => createHmac("sha256", keyFor(secret)).update(body).digest("base64url");
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function sealEntraState(secret: string, value: EntraFlowState, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...value, exp: Math.floor(now / 1000) + ENTRA_STATE_TTL_SECONDS })).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

/** The sealed state, or null when it's missing, tampered with, malformed or expired. */
export function openEntraState(secret: string, raw: string | undefined, now = Date.now()): EntraFlowState | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const given = Buffer.from(sig);
  const expected = Buffer.from(mac(secret, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v.exp !== "number" || v.exp * 1000 <= now) return null;
  if (!nonEmpty(v.state) || !nonEmpty(v.nonce) || !nonEmpty(v.codeVerifier) || !nonEmpty(v.returnTo)) return null;
  return { state: v.state, nonce: v.nonce, codeVerifier: v.codeVerifier, returnTo: v.returnTo };
}

export function entraStateCookie(value: string, opts: { secure: boolean }): string {
  return [`${ENTRA_STATE_COOKIE}=${value}`, `Path=${ENTRA_STATE_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${ENTRA_STATE_TTL_SECONDS}`, ...(opts.secure ? ["Secure"] : [])].join("; ");
}

export function clearedEntraStateCookie(opts: { secure: boolean }): string {
  return [`${ENTRA_STATE_COOKIE}=`, `Path=${ENTRA_STATE_PATH}`, "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(opts.secure ? ["Secure"] : [])].join("; ");
}
```

Create `apps/core/src/entra/return-to.ts`:

```ts
const FALLBACK = "/hub/";
const MAX_LENGTH = 512;
const PROBE_ORIGIN = "https://return-to.invalid";

/**
 * Where to send the browser after Entra sign-in: a same-origin path under /hub/, by the same
 * rules as staff-web's safeReturnTo (a leading single slash, no backslash), and also no control
 * characters, at most 512 characters, and still under /hub/ once dot segments are resolved.
 * Anything else is /hub/.
 */
export function safeHubReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return FALLBACK;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return FALLBACK;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== PROBE_ORIGIN) return FALLBACK;
  if (url.pathname !== "/hub" && !url.pathname.startsWith("/hub/")) return FALLBACK;
  return `${url.pathname === "/hub" ? FALLBACK : url.pathname}${url.search}${url.hash}`;
}
```

Run: `npx vitest run apps/core/src/entra`
Expected: 34 tests pass.

- [ ] **Step 5: Write the failing flow tests**

Create `apps/core/src/entra/routes.test.ts`. It runs the fake on a real loopback port, because openid-client makes real HTTP calls, and drives Core through supertest:

```ts
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword } from "@gcpe/auth";
import { createFakeOidc, type FakeOidc, type FakeOidcTokenOverrides } from "@gcpe/oidc-fake";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema, matchEntraUser, updateUser } from "../services/users";
import { createEntraClient } from "./client";
import type { EntraSignInConfig } from "./config";
import { openEntraState, sealEntraState } from "./state-cookie";

const SECRET = "session-secret-for-entra-tests-0123456789";
const TENANT = "0000fa4e-0000-4000-8000-000000000003";
const REDIRECT = "https://hub.example.test/core/auth/entra/callback";
const PW = "a long enough password";
const IDENTITIES = [
  { key: "staff", oid: "oid-staff", email: "Staff.Person@example.test", name: "Staff Person" },
  { key: "unknown", oid: "oid-unknown", email: "unknown.person@example.test", name: "Unknown Person" },
  { key: "idle", oid: "oid-idle", email: "idle.person@example.test", name: "Idle Person" },
  { key: "impostor", oid: "oid-impostor", email: "taken.person@example.test", name: "Taken Person" },
];

function setCookies(res: request.Response): string[] {
  return (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
}
const cookieValue = (res: request.Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(";")[0];

describe("Entra sign-in routes", () => {
  let tdb: TestDatabase;
  let server: Server;
  let fake: FakeOidc;
  let cfg: EntraSignInConfig;
  let app: express.Express;
  let staffId: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const fakeApp = express();
    server = fakeApp.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fake-entra`;
    fake = await createFakeOidc({ tenantId: TENANT, clientId: "core-client", clientSecret: "core-secret", redirectUris: [REDIRECT], serverBase: base, browserBase: base, identities: IDENTITIES });
    fakeApp.use("/fake-entra", fake.router);
    cfg = { tenantId: TENANT, clientId: "core-client", clientSecret: "core-secret", authority: fake.issuer, redirectUri: REDIRECT };
    const local = { username: "admin", passwordHash: await hashPassword("break glass password!"), secret: "local-secret-for-entra-tests-0123456789" };
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: true, local, entra: createEntraClient(cfg), entraRatePerMinute: 1000 } });
    staffId = (await createUser(tdb.db, createUserSchema.parse({ email: "staff.person@example.test", displayName: "Staff Person", roles: ["NRMS.Editor"], password: PW }), [])).id;
    const idle = await createUser(tdb.db, createUserSchema.parse({ email: "idle.person@example.test", displayName: "Idle Person" }), []);
    await updateUser(tdb.db, idle.id, { isActive: false }, []);
    await createUser(tdb.db, createUserSchema.parse({ email: "taken.person@example.test", displayName: "Taken Person" }), []);
    await matchEntraUser(tdb.db, "oid-original-owner", "taken.person@example.test");
  });
  afterAll(async () => {
    server.close();
    await tdb.drop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** GET /auth/entra, then the fake's picker as a browser would. Returns the callback query and the state cookie. */
  async function startAndPick(key: string, returnTo = "/hub/search?q=fire"): Promise<{ start: request.Response; query: string; stateCookie: string }> {
    const start = await request(app).get(`/auth/entra?returnTo=${encodeURIComponent(returnTo)}`);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.location!);
    const page = await (await fetch(authorize)).text();
    const href = new RegExp(`href="(authorize/approve[^"]*user=${key})"`).exec(page)![1]!.replace(/&amp;/g, "&");
    const approved = await fetch(new URL(href, authorize), { redirect: "manual" });
    const back = new URL(approved.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    return { start, query: back.search.slice(1), stateCookie: cookieValue(start, "gcpe_entra")! };
  }
  const callback = (query: string, stateCookie?: string) => {
    const r = request(app).get(`/auth/entra/callback?${query}`);
    return stateCookie ? r.set("cookie", `gcpe_entra=${stateCookie}`) : r;
  };
  async function signIn(key: string, overrides?: FakeOidcTokenOverrides) {
    const { query, stateCookie } = await startAndPick(key);
    if (overrides) fake.controls.setNextTokenOverrides(overrides);
    return callback(query, stateCookie);
  }

  it("GET /auth/entra sets the state cookie and sends the browser to Microsoft with PKCE, state, nonce and select_account", async () => {
    const res = await request(app).get("/auth/entra");
    const to = new URL(res.headers.location!);
    expect(to.href.startsWith(`${fake.issuer.replace(/\/v2\.0$/, "")}/oauth2/v2.0/authorize`)).toBe(true);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: "core-client", redirect_uri: REDIRECT, response_type: "code", scope: "openid profile email", code_challenge_method: "S256", prompt: "select_account" });
    const saved = openEntraState(SECRET, cookieValue(res, "gcpe_entra"))!;
    expect(to.searchParams.get("state")).toBe(saved.state);
    expect(to.searchParams.get("nonce")).toBe(saved.nonce);
    expect(saved.returnTo).toBe("/hub/");
    expect(setCookies(res)[0]).toMatch(/^gcpe_entra=[^;]+; Path=\/core\/auth\/entra; HttpOnly; SameSite=Lax; Max-Age=300; Secure$/);
  });

  it("signs a provisioned user in with the same gcpe_session cookie as password sign-in, clears the state cookie and returns to the page", async () => {
    const res = await signIn("staff");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/hub/search?q=fire");
    expect(setCookies(res)).toContain("gcpe_entra=; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    const entraCookie = setCookies(res).find((c) => c.startsWith("gcpe_session="))!;

    const password = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "staff.person@example.test", password: PW });
    // Linked now, so the password is refused; the shape comparison uses a second, unlinked user.
    expect(password.status).toBe(401);
    const other = await createUser(tdb.db, createUserSchema.parse({ email: "shape.check@example.test", displayName: "Shape Check", roles: ["NRMS.Editor"], password: PW }), []);
    const local = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "shape.check@example.test", password: PW });
    const localCookie = setCookies(local).find((c) => c.startsWith("gcpe_session="))!;
    const attrs = (c: string) => c.split("; ").slice(1);
    expect(attrs(entraCookie)).toEqual(attrs(localCookie));
    const entraClaims = decodeJwt(cookieValue(res, "gcpe_session")!);
    const localClaims = decodeJwt(cookieValue(local, "gcpe_session")!);
    expect(Object.keys(entraClaims).sort()).toEqual(Object.keys(localClaims).sort());
    expect(entraClaims).toMatchObject({ sub: staffId, name: "Staff Person", email: "staff.person@example.test", roles: ["NRMS.Editor"] });
    expect(localClaims).toMatchObject({ sub: other.id, roles: ["NRMS.Editor"] });

    const session = await request(app).get("/auth/session").set("cookie", `gcpe_session=${cookieValue(res, "gcpe_session")}`);
    expect(session.body.user).toEqual({ id: staffId, name: "Staff Person", email: "staff.person@example.test", roles: ["NRMS.Editor"] });
  });

  it.each([
    ["not_provisioned", "unknown"],
    ["inactive", "idle"],
    ["conflict", "impostor"],
  ])("refuses with %s and issues no session", async (code, key) => {
    const res = await signIn(key);
    expect(res.headers.location).toBe(`/hub/sign-in?error=${code}`);
    expect(cookieValue(res, "gcpe_session")).toBeUndefined();
  });

  it.each([
    ["a wrong nonce", { nonce: "another-nonce" }],
    ["the wrong audience", { aud: "another-client" }],
    ["the wrong issuer", { iss: "https://login.microsoftonline.com/another/v2.0" }],
    ["the wrong tenant", { tid: "0000fa4e-0000-4000-8000-0000000000ff" }],
    ["a signature the tenant's JWKS doesn't verify", { signWithUnpublishedKey: true }],
  ])("refuses a token with %s as failed", async (_label, overrides) => {
    const res = await signIn("staff", overrides);
    expect(res.headers.location).toBe("/hub/sign-in?error=failed");
    expect(cookieValue(res, "gcpe_session")).toBeUndefined();
  });

  it("refuses a wrong PKCE verifier as failed (the token endpoint rejects it)", async () => {
    const { query, stateCookie } = await startAndPick("staff");
    const saved = openEntraState(SECRET, stateCookie)!;
    const res = await callback(query, sealEntraState(SECRET, { ...saved, codeVerifier: "w".repeat(43) }));
    expect(res.headers.location).toBe("/hub/sign-in?error=failed");
  });

  it("refuses as expired: no state cookie, a mismatched state, an expired cookie, or a cookie without a verifier", async () => {
    const { query, stateCookie } = await startAndPick("staff");
    const saved = openEntraState(SECRET, stateCookie)!;
    expect((await callback(query)).headers.location).toBe("/hub/sign-in?error=expired");
    expect((await callback(query, sealEntraState(SECRET, { ...saved, state: "another-state" }))).headers.location).toBe("/hub/sign-in?error=expired");
    expect((await callback(query, sealEntraState(SECRET, saved, Date.now() - 6 * 60_000))).headers.location).toBe("/hub/sign-in?error=expired");
    expect((await callback(query, sealEntraState(SECRET, { ...saved, codeVerifier: "" }))).headers.location).toBe("/hub/sign-in?error=expired");
  });

  it("maps access_denied to cancelled, any other error and a missing code to failed", async () => {
    const { stateCookie } = await startAndPick("staff");
    const state = openEntraState(SECRET, stateCookie)!.state;
    expect((await callback(`error=access_denied&state=${state}`, stateCookie)).headers.location).toBe("/hub/sign-in?error=cancelled");
    expect((await callback(`error=server_error&state=${state}`, stateCookie)).headers.location).toBe("/hub/sign-in?error=failed");
    expect((await callback(`state=${state}`, stateCookie)).headers.location).toBe("/hub/sign-in?error=failed");
  });

  it("sends an unsafe returnTo to /hub/", async () => {
    const { query, stateCookie } = await startAndPick("staff", "https://evil.example.test/hub/");
    expect((await callback(query, stateCookie)).headers.location).toBe("/hub/");
  });

  it("logs only the route, the code and the user id: never tokens, codes, state, emails or names", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const { query, stateCookie } = await startAndPick("impostor");
    await callback(query, stateCookie);
    await signIn("staff", { aud: "another-client" });
    const params = new URLSearchParams(query);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[core\] entra sign-in refused route=\/auth\/entra\/callback code=conflict user=[0-9a-f-]{36}$/);
    expect(lines[1]).toMatch(/^\[core\] entra sign-in refused route=\/auth\/entra\/callback code=failed error=[A-Z_]+$/);
    for (const secret of [params.get("code")!, params.get("state")!, "taken.person", "Taken Person", "staff.person", "Staff Person"]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  it("a discovery failure sends the browser back with failed, and is retried on the next sign-in", async () => {
    const broken = createApp({
      db: tdb.db,
      subscribers: [],
      auth: { session: { secret: SECRET } },
      session: { secret: SECRET, secure: true, local: null, entra: createEntraClient({ ...cfg, authority: "http://127.0.0.1:1/nowhere/v2.0" }) },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(broken).get("/auth/entra");
    expect(res.headers.location).toBe("/hub/sign-in?error=failed");
    expect(cookieValue(res, "gcpe_entra")).toBeUndefined();
  });

  it("GET /auth/methods reports Entra and local sign-in", async () => {
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: true, local: true });
  });
});

describe("sign-in methods and production password rules", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
    await createUser(tdb.db, createUserSchema.parse({ email: "pw.user@example.test", displayName: "Password User", roles: ["NRMS.Viewer"], password: PW }), []);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const entra = () => createEntraClient({ tenantId: TENANT, clientId: "c", clientSecret: "s", authority: "http://127.0.0.1:1/unused/v2.0", redirectUri: REDIRECT });
  const appWith = async (session: { entra: ReturnType<typeof entra> | null; userPasswordsAllowed: boolean; breakGlass: boolean }) =>
    createApp({
      db: tdb.db,
      subscribers: [],
      auth: { session: { secret: SECRET } },
      session: {
        secret: SECRET,
        secure: true,
        local: session.breakGlass ? { username: "admin", passwordHash: await hashPassword("break glass password!"), secret: "local-secret-for-entra-tests-0123456789" } : null,
        entra: session.entra,
        userPasswordsAllowed: session.userPasswordsAllowed,
      },
    });
  const login = (app: express.Express, username: string, password: string) => request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username, password });

  it("Entra off: no Entra routes, passwords as before", async () => {
    const app = await appWith({ entra: null, userPasswordsAllowed: true, breakGlass: false });
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: false, local: true });
    expect((await request(app).get("/auth/entra")).status).toBe(404);
    expect((await login(app, "pw.user@example.test", PW)).status).toBe(200);
  });

  it("production with Entra on: user passwords refused like a wrong password; break-glass still works", async () => {
    const app = await appWith({ entra: entra(), userPasswordsAllowed: false, breakGlass: true });
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: true, local: true });
    const refused = await login(app, "pw.user@example.test", PW);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "invalid credentials" });
    expect((await login(app, "admin", "break glass password!")).status).toBe(200);
  });

  it("production with Entra on and no break-glass: the screen offers Microsoft only", async () => {
    const app = await appWith({ entra: entra(), userPasswordsAllowed: false, breakGlass: false });
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: true, local: false });
  });
});
```

Add to the end of `describe("startCore", …)` in `apps/core/src/start.test.ts`:

```ts
  it("refuses to start with Entra sign-in partly configured, naming what's missing", async () => {
    await expect(startCore({ ...(await testEnv()), ENTRA_CLIENT_ID: "core-client" })).rejects.toThrow(
      "Entra sign-in is partly configured: missing ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET, PUBLIC_BASE_URL, SESSION_SECRET",
    );
  });
```

In `apps/stack/src/stack-check.test.ts`, add these two tests directly before `it("fails LOCAL_ADMIN_ENABLED=true under NODE_ENV=production without the explicit override", …)`:

```ts
  it("fails Core when Entra sign-in is partly configured, naming the missing settings", async () => {
    const result = await checkStack({ ...baseEnv(), CORE_ENTRA_CLIENT_ID: "core-client" });
    expect(result.ok).toBe(false);
    expect(result.apps.core?.ok).toBe(false);
    expect(result.apps.core?.error).toContain("(its variables are CORE_*)");
    expect(result.apps.core?.error).toContain("Entra sign-in is partly configured: missing ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET, PUBLIC_BASE_URL, SESSION_SECRET");
    expect(result.apps.nrms?.ok).toBe(true);
  });

  it("passes Core with Entra sign-in fully configured", async () => {
    const result = await checkStack({
      ...baseEnv(),
      ENTRA_TENANT_ID: "0000fa4e-0000-4000-8000-000000000004",
      SESSION_SECRET: "s".repeat(32),
      CORE_AUTH_AUDIENCE: "api://core.example.test",
      CORE_ENTRA_CLIENT_ID: "core-client",
      CORE_ENTRA_CLIENT_SECRET: "core-secret",
      CORE_PUBLIC_BASE_URL: "https://news.example.test",
    });
    expect(result.apps.core).toEqual({ ok: true, migrationsFolder: expect.any(String) });
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run apps/core/src/entra/routes.test.ts apps/core/src/start.test.ts apps/stack/src/stack-check.test.ts`
Expected: FAIL. `./client` doesn't exist. The new `start.test.ts` and `stack-check.test.ts` cases fail because nothing reads the Entra settings yet.

- [ ] **Step 7: Implement the shared session cookie**

Create `apps/core/src/http/session-cookie.ts`:

```ts
import { mintSession, SESSION_TTL_SECONDS, sessionCookie, type SessionUser } from "@gcpe/auth";

/** The one way Core issues a staff session, for password and Entra sign-in alike: the same
 * token, the same `gcpe_session` cookie attributes. `expiresAt` is Unix seconds. */
export async function newSessionCookie(secret: string, secure: boolean, user: SessionUser): Promise<{ cookie: string; expiresAt: number }> {
  const { token, expiresAt } = await mintSession(secret, user);
  return { cookie: sessionCookie(token, { secure, maxAgeSeconds: SESSION_TTL_SECONDS }), expiresAt };
}
```

- [ ] **Step 8: Implement the openid-client wrapper and the routes**

Create `apps/core/src/entra/client.ts`:

```ts
import * as oidc from "openid-client";
import type { EntraSignInConfig } from "./config";

/** What Core takes from a validated Entra ID token. */
export interface EntraIdentity {
  oid: string;
  /** preferred_username, else email; trimmed and lowercased. Null when neither is an address. */
  email: string | null;
}

export interface EntraChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface EntraClient {
  authorizationUrl(checks: Pick<EntraChecks, "state" | "nonce" | "codeChallenge">): Promise<URL>;
  /** Exchanges the callback's code and validates the ID token: issuer, audience, signature,
   * nonce, state, PKCE (by the token endpoint) and the tenant. Throws on any failure. */
  exchange(input: { callbackQuery: string; state: string; nonce: string; codeVerifier: string }): Promise<EntraIdentity>;
}

/** A token that passed openid-client's checks but isn't one Core accepts. `code` is safe to log. */
export class EntraTokenError extends Error {
  constructor(readonly code: "missing_oid" | "wrong_tenant") {
    super(code);
    this.name = "EntraTokenError";
  }
}

export async function newEntraChecks(): Promise<EntraChecks> {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  return { state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier, codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier) };
}

export function entraEmailOf(claims: Record<string, unknown>): string | null {
  for (const v of [claims.preferred_username, claims.email]) {
    if (typeof v === "string") {
      const e = v.trim().toLowerCase();
      if (e.includes("@")) return e;
    }
  }
  return null;
}

/** openid-client, discovering the tenant's metadata on first use and caching it (a failed
 * discovery is retried on the next sign-in). */
export function createEntraClient(cfg: EntraSignInConfig): EntraClient {
  let discovered: Promise<oidc.Configuration> | undefined;
  const config = (): Promise<oidc.Configuration> =>
    (discovered ??= (async () => {
      // http is only possible for a test site's fake (ENTRA_AUTHORITY_URL is refused in production).
      const insecure = new URL(cfg.authority).protocol === "http:";
      const c = await oidc.discovery(new URL(cfg.authority), cfg.clientId, undefined, oidc.ClientSecretPost(cfg.clientSecret), insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
      // Also verify the ID token's signature against the tenant's JWKS, not only TLS to the token endpoint.
      oidc.enableNonRepudiationChecks(c);
      return c;
    })().catch((e: unknown) => {
      discovered = undefined;
      throw e;
    }));

  return {
    async authorizationUrl({ state, nonce, codeChallenge }) {
      return oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: cfg.redirectUri,
        scope: "openid profile email",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        nonce,
        prompt: "select_account",
      });
    },
    async exchange({ callbackQuery, state, nonce, codeVerifier }) {
      // openid-client sends redirect_uri as this URL without its query, so it must be the registered URI.
      const current = new URL(`${cfg.redirectUri}?${callbackQuery}`);
      const tokens = await oidc.authorizationCodeGrant(await config(), current, { pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
      const claims = (tokens.claims() ?? {}) as Record<string, unknown>;
      if (typeof claims.oid !== "string" || claims.oid === "") throw new EntraTokenError("missing_oid");
      if (claims.tid !== cfg.tenantId) throw new EntraTokenError("wrong_tenant");
      return { oid: claims.oid, email: entraEmailOf(claims) };
    },
  };
}
```

Create `apps/core/src/entra/routes.ts`:

```ts
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { Db } from "@gcpe/db-kit";
import { readCookie } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";
import { matchEntraUser, type EntraRefusal } from "../services/users";
import { newSessionCookie } from "../http/session-cookie";
import { newEntraChecks, type EntraClient } from "./client";
import { safeHubReturnTo } from "./return-to";
import { clearedEntraStateCookie, ENTRA_STATE_COOKIE, entraStateCookie, openEntraState, sealEntraState } from "./state-cookie";

/** The `?error=` codes the staff sign-in screen shows a message for. */
export type EntraErrorCode = "cancelled" | "expired" | "failed" | EntraRefusal;

export interface EntraRouteDeps {
  db: Db;
  secret: string;
  secure: boolean;
  entra: EntraClient;
  ratePerMinute?: number;
}

// Codes an administrator may need to act on go to console.error, which the stack's error log captures.
const NEEDS_ADMIN = new Set<EntraErrorCode>(["failed", "conflict"]);

function refuse(res: Response, route: string, code: EntraErrorCode, extra: { userId?: string; error?: unknown } = {}): void {
  const line = `[core] entra sign-in refused route=${route} code=${code}${extra.userId ? ` user=${extra.userId}` : ""}${extra.error !== undefined ? ` error=${safeErrorLabel(extra.error)}` : ""}`;
  (NEEDS_ADMIN.has(code) ? console.error : console.warn)(line);
  res.redirect(302, `/hub/sign-in?error=${code}`);
}

const queryOf = (req: Request): string => {
  const i = req.originalUrl.indexOf("?");
  return i < 0 ? "" : req.originalUrl.slice(i + 1);
};

/** GET /auth/entra and GET /auth/entra/callback: the authorization-code flow with PKCE. Public routes. */
export function entraRoutes(deps: EntraRouteDeps): Router {
  const r = Router();
  const limit = () => rateLimit({ windowMs: 60_000, limit: deps.ratePerMinute ?? 30, standardHeaders: "draft-7", legacyHeaders: false });
  const cookieOpts = { secure: deps.secure };

  r.get("/auth/entra", limit(), async (req, res) => {
    const returnTo = safeHubReturnTo(req.query.returnTo);
    try {
      const checks = await newEntraChecks();
      const url = await deps.entra.authorizationUrl(checks);
      res.setHeader("set-cookie", entraStateCookie(sealEntraState(deps.secret, { state: checks.state, nonce: checks.nonce, codeVerifier: checks.codeVerifier, returnTo }), cookieOpts));
      res.redirect(302, url.href);
    } catch (e) {
      refuse(res, "/auth/entra", "failed", { error: e });
    }
  });

  r.get("/auth/entra/callback", limit(), async (req, res) => {
    const route = "/auth/entra/callback";
    const saved = openEntraState(deps.secret, readCookie(req.header("cookie"), ENTRA_STATE_COOKIE));
    const cleared = clearedEntraStateCookie(cookieOpts);
    res.setHeader("set-cookie", cleared);
    const { error, state, code } = req.query;
    if (error !== undefined) return refuse(res, route, error === "access_denied" ? "cancelled" : "failed");
    if (!saved || typeof state !== "string" || state !== saved.state) return refuse(res, route, "expired");
    if (typeof code !== "string" || code === "") return refuse(res, route, "failed");
    try {
      const identity = await deps.entra.exchange({ callbackQuery: queryOf(req), state: saved.state, nonce: saved.nonce, codeVerifier: saved.codeVerifier });
      const match = await matchEntraUser(deps.db, identity.oid, identity.email);
      if (!match.ok) return refuse(res, route, match.code, { userId: match.userId });
      const { cookie } = await newSessionCookie(deps.secret, deps.secure, match.user);
      res.setHeader("set-cookie", [cleared, cookie]);
      res.redirect(302, safeHubReturnTo(saved.returnTo));
    } catch (e) {
      refuse(res, route, "failed", { error: e });
    }
  });

  return r;
}
```

- [ ] **Step 9: Wire the routes, `/auth/methods` and the password rule into `sessionRoutes`**

In `apps/core/src/http/session.ts`:

1. Replace the `@gcpe/auth` import block and the `../services/users` import with:

```ts
import {
  ADMIN_ROLES,
  clearedSessionCookie,
  CSRF_HEADER,
  readCookie,
  SESSION_COOKIE,
  SESSION_RENEW_WINDOW_SECONDS,
  verifyPassword,
  verifySession,
  type LocalAuthConfig,
  type SessionUser,
  type VerifiedSession,
} from "@gcpe/auth";
import type { EntraClient } from "../entra/client";
import { entraRoutes } from "../entra/routes";
import { authenticate, sessionRolesOf, sessionUserFor } from "../services/users";
import { newSessionCookie } from "./session-cookie";
```

2. In `SessionRouteDeps`, replace `ratePerMinute?: number;` with:

```ts
  /** Entra sign-in, when configured. */
  entra?: EntraClient | null;
  /** False refuses every users-row password (production with Entra on); break-glass is unaffected. Default true. */
  userPasswordsAllowed?: boolean;
  ratePerMinute?: number;
  /** Per-IP limit on each Entra route. Default 30 a minute. */
  entraRatePerMinute?: number;
```

3. Replace the `issue` helper with the following, which keeps the same response and uses the shared cookie, and add the flag below it:

```ts
  const issue = async (res: Response, user: SessionUser) => {
    const { cookie, expiresAt } = await newSessionCookie(deps.secret, deps.secure, user);
    res.setHeader("set-cookie", cookie);
    res.json({ user, expiresAt: new Date(expiresAt * 1000).toISOString() });
  };
  const userPasswordsAllowed = deps.userPasswordsAllowed ?? true;
```

4. In `POST /auth/login`, change `const user = await authenticate(deps.db, username, password);` to:

```ts
        const user = await authenticate(deps.db, username, password, { usersAllowed: userPasswordsAllowed });
```

5. Directly before `r.post("/auth/logout", …)`, add:

```ts
  /** Which sign-in methods the sign-in screen offers. `local` covers the break-glass admin too. */
  r.get("/auth/methods", (_req, res) => {
    res.json({ entra: deps.entra != null, local: userPasswordsAllowed || deps.local !== null });
  });

  if (deps.entra) r.use(entraRoutes({ db: deps.db, secret: deps.secret, secure: deps.secure, entra: deps.entra, ratePerMinute: deps.entraRatePerMinute }));
```

In `apps/core/src/app.ts`, add `import type { EntraClient } from "./entra/client";` after the `./http/routes` import, and change the `session` dependency type to:

```ts
  session?: { secret: string; secure: boolean; local: LocalAuthConfig | null; entra?: EntraClient | null; userPasswordsAllowed?: boolean; entraRatePerMinute?: number };
```

- [ ] **Step 10: Read the settings at startup and in `--check`**

In `apps/core/src/start.ts`, add the imports after `import { createApp } from "./app";`:

```ts
import { createEntraClient } from "./entra/client";
import { signInSettingsFromEnv } from "./entra/config";
```

After `const auth = authFromEnv(env);` add `const signIn = signInSettingsFromEnv(env);`. It must come before `createDb`, so a bad configuration fails before any connection. Then replace the `session:` line in `createApp({...})` with:

```ts
    session: auth.session
      ? {
          secret: auth.session.secret,
          secure: parsed.SESSION_COOKIE_SECURE,
          local: auth.local,
          entra: signIn.entra ? createEntraClient(signIn.entra) : null,
          userPasswordsAllowed: signIn.userPasswordsAllowed,
        }
      : undefined,
```

In `apps/stack/src/stack.ts`, add `import { signInSettingsFromEnv } from "../../core/src/entra/config";` directly before the `../../core/src/start` import. In `checkStack`'s per-app loop, directly before `if (c.label === "calendar" && calendarStorageError) errors.push(calendarStorageError);`, add:

```ts
    // Core's sign-in settings (Entra on or off, partial configuration), checked as startCore checks them.
    if (c.prefix === "CORE") {
      try {
        signInSettingsFromEnv(view);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx vitest run apps/core apps/stack/src/stack-check.test.ts packages/oidc-fake`
Expected: all pass (about 260 tests). The flow suite prints no `[core] entra sign-in refused` lines, because the logging test mocks them.

Discriminating check (do it, then undo it): comment out `oidc.enableNonRepudiationChecks(c);` and the `wrong_tenant` line in `client.ts`, then rerun `npx vitest run apps/core/src/entra/routes.test.ts`. Expected: exactly the two tests "…the wrong tenant…" and "…a signature the tenant's JWKS doesn't verify…" fail. Restore both lines.

- [ ] **Step 12: Type check and commit**

Run: `npx tsc -p tsconfig.json`. Expected: no output.

```bash
git add apps/core/package.json package-lock.json apps/core/src/entra apps/core/src/http/session-cookie.ts apps/core/src/http/session.ts apps/core/src/app.ts apps/core/src/start.ts apps/core/src/start.test.ts apps/stack/src/stack.ts apps/stack/src/stack-check.test.ts
git commit -m "feat(core): Entra sign-in with PKCE, signed state cookie and the shared staff session"
```

---
### Task 4: Staff web: "Sign in with Microsoft", error messages, unlink button — **lighter review**

**Files:**
- Modify (full replacement): `apps/staff-web/src/screens/SignIn.tsx`
- Modify: `apps/staff-web/src/styles/global.css`
- Modify: `apps/staff-web/src/screens/admin/users/UsersScreen.tsx`
- Test: `apps/staff-web/src/screens/SignIn.test.tsx`, `apps/staff-web/src/screens/admin/users/UsersScreen.test.tsx`

**Interfaces:**
- Consumes (Task 3 and Task 2 HTTP): `GET /core/auth/methods` → `{ entra, local }`. `/core/auth/entra?returnTo=/hub/...`. `/hub/sign-in?error=<code>`. `POST /core/api/users/:id/unlink-entra`.
- Produces: `export const ENTRA_ERRORS: Record<string, string>` from `SignIn.tsx`. The link's accessible name is "Sign in with Microsoft". The users screen shows "Sign-in: Microsoft (Entra)", and the unlink button is named "Unlink <email> from Microsoft sign-in" (Task 5's e2e relies on these).

- [ ] **Step 1: Write the failing sign-in tests**

In `apps/staff-web/src/screens/SignIn.test.tsx`:

1. Change `import { SignIn } from "./SignIn";` to `import { ENTRA_ERRORS, SignIn } from "./SignIn";`.
2. Replace the `stubFetch` function and its doc comment with:

```tsx
/** /core/auth/session (SessionProvider's own initial load) always answers 401 here — these
 * tests start signed out, same as a real visit to /hub/sign-in. /core/auth/methods answers
 * `methods` (password only, unless a test says otherwise). */
function stubFetch(loginHandler: (init: RequestInit) => Response, methods: Response = jsonResponse(200, { entra: false, local: true })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/core/auth/session") return jsonResponse(401, { error: "not signed in" });
      if (url === "/core/auth/methods") return methods.clone();
      if (url === "/core/auth/login") return loginHandler(init);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}
const noLogin = () => jsonResponse(401, { error: "invalid credentials" });
```

3. Add these tests at the end of `describe("SignIn", …)`:

```tsx
  it("offers Sign in with Microsoft when Entra is on, carrying the return path under /hub", async () => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: true }));
    renderSignIn("/sign-in?return=%2Freleases%2Fabc");
    const link = await screen.findByRole("link", { name: "Sign in with Microsoft" });
    expect(link).toHaveAttribute("href", "/core/auth/entra?returnTo=%2Fhub%2Freleases%2Fabc");
    expect(screen.getByLabelText(/user name/i)).toBeInTheDocument();
    // The Microsoft control is a link, so the form's own button stays the only "Sign in" button.
    expect(screen.getAllByRole("button", { name: /sign in/i })).toHaveLength(1);
  });

  it("an unsafe return path becomes /hub/ in the Microsoft link", async () => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: true }));
    renderSignIn("/sign-in?return=%2F%2Fevil.example.test");
    expect(await screen.findByRole("link", { name: "Sign in with Microsoft" })).toHaveAttribute("href", "/core/auth/entra?returnTo=%2Fhub%2F");
  });

  it("shows only the Microsoft link when passwords are off", async () => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: false }));
    renderSignIn();
    await screen.findByRole("link", { name: "Sign in with Microsoft" });
    expect(screen.queryByLabelText(/user name/i)).not.toBeInTheDocument();
  });

  it("shows the password form only when Entra is off or the methods can't be read", async () => {
    stubFetch(noLogin, jsonResponse(500, { error: "boom" }));
    renderSignIn();
    await screen.findByLabelText(/user name/i);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toContain("/core/auth/methods"));
    expect(screen.queryByRole("link", { name: "Sign in with Microsoft" })).not.toBeInTheDocument();
  });

  it.each(Object.entries(ENTRA_ERRORS))("shows the message for ?error=%s", async (code, message) => {
    stubFetch(noLogin, jsonResponse(200, { entra: true, local: true }));
    renderSignIn(`/sign-in?error=${code}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("uses the agreed wording, and shows nothing for an unknown code", async () => {
    expect(ENTRA_ERRORS).toEqual({
      cancelled: "Sign-in was cancelled.",
      expired: "Your sign-in took too long. Please try again.",
      failed: "We couldn't sign you in with Microsoft. Please try again.",
      not_provisioned: "Your account hasn't been set up. Contact an administrator.",
      inactive: "Your account hasn't been set up. Contact an administrator.",
      conflict: "Your account needs an administrator to check it. Contact an administrator.",
    });
    stubFetch(noLogin);
    renderSignIn("/sign-in?error=<script>");
    await screen.findByLabelText(/user name/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Write the failing unlink tests**

Add these tests at the end of `describe("UsersScreen", …)` in `apps/staff-web/src/screens/admin/users/UsersScreen.test.tsx`:

```tsx
  it("unlinks a user's Microsoft sign-in, then offers a password again", async () => {
    const LINKED: UserView = { ...OTHER, signInMethod: "entra" };
    let current = LINKED;
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, current]);
      if (url === "/core/api/users/other-1/unlink-entra" && init?.method === "POST") {
        current = { ...OTHER, signInMethod: "local" };
        return jsonResponse(200, current);
      }
      return null;
    });
    render(withAuth(<UsersScreen />));
    const row = (await screen.findByRole("heading", { name: "other@x.invalid", level: 3 })).closest("li")!;
    expect(within(row).getByText("Sign-in: Microsoft (Entra)")).toBeInTheDocument();
    expect(within(row).queryByLabelText("other@x.invalid new password")).not.toBeInTheDocument();

    await userEvent.setup().click(within(row).getByRole("button", { name: "Unlink other@x.invalid from Microsoft sign-in" }));

    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users/other-1/unlink-entra" && c.init?.method === "POST")).toBe(true));
    const after = (await screen.findByRole("heading", { name: "other@x.invalid", level: 3 })).closest("li")!;
    expect(await within(after).findByText("Sign-in: Local password")).toBeInTheDocument();
    expect(within(after).getByLabelText("other@x.invalid new password")).toBeInTheDocument();
    expect(within(after).queryByRole("button", { name: /unlink/i })).not.toBeInTheDocument();
  });

  it("shows the server's message when unlinking fails", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, { ...OTHER, signInMethod: "entra" }]);
      if (url === "/core/api/users/other-1/unlink-entra") return jsonResponse(404, { error: "not found" });
      return null;
    });
    render(withAuth(<UsersScreen />));
    const row = (await screen.findByRole("heading", { name: "other@x.invalid", level: 3 })).closest("li")!;
    await userEvent.setup().click(within(row).getByRole("button", { name: "Unlink other@x.invalid from Microsoft sign-in" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("not found");
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run --project staff-web apps/staff-web/src/screens/SignIn.test.tsx apps/staff-web/src/screens/admin/users/UsersScreen.test.tsx`
Expected: FAIL. `ENTRA_ERRORS` is undefined, there's no "Sign in with Microsoft" link, and there's no unlink button or "Microsoft (Entra)" text.

- [ ] **Step 4: Replace the sign-in screen**

Replace `apps/staff-web/src/screens/SignIn.tsx` entirely with:

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Button, Form, Header, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { ApiError, apiFetch } from "../api/client";
import { safeReturnTo } from "../session/safeReturnTo";
import { useSession } from "../session/SessionContext";
import { useDocumentTitle } from "../shared/useDocumentTitle";

const SIGN_IN_FAILED = "Sign-in failed. Check your user name and password.";
const RATE_LIMITED = "Too many attempts, wait a minute";
const NOT_SET_UP = "Your account hasn't been set up. Contact an administrator.";

/** Core's `?error=` codes from Microsoft sign-in (GET /core/auth/entra/callback). */
export const ENTRA_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "Your sign-in took too long. Please try again.",
  failed: "We couldn't sign you in with Microsoft. Please try again.",
  not_provisioned: NOT_SET_UP,
  inactive: NOT_SET_UP,
  conflict: "Your account needs an administrator to check it. Contact an administrator.",
};

interface SignInMethods {
  entra: boolean;
  local: boolean;
}
/** Until Core answers, or if it can't: the password form only, as before Entra. */
const DEFAULT_METHODS: SignInMethods = { entra: false, local: true };

export function SignIn(): React.JSX.Element {
  const { user, signIn } = useSession();
  useDocumentTitle("Sign in");
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [methods, setMethods] = useState<SignInMethods>(DEFAULT_METHODS);

  useEffect(() => {
    let live = true;
    apiFetch<SignInMethods>("/core/auth/methods").then(
      (m) => live && setMethods({ entra: m.entra === true, local: m.local !== false }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const returnTo = safeReturnTo(params.get("return"));
  if (user) return <Navigate to={returnTo} replace />;

  const entraError = ENTRA_ERRORS[params.get("error") ?? ""] ?? null;
  // Core takes a /hub/ path: the router's paths are relative to its /hub basename.
  const entraHref = `/core/auth/entra?returnTo=${encodeURIComponent(`/hub${returnTo}`)}`;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(username, password);
      // Render falls through to the `user` redirect above on the next render.
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 429 ? RATE_LIMITED : SIGN_IN_FAILED);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="gcpe-sign-in">
      <Header title="GCPE News — Staff" />
      <h1>Sign in</h1>
      {(error ?? entraError) && <InlineAlert variant="danger" role="alert" description={(error ?? entraError)!} />}
      {methods.entra && (
        <p className="gcpe-sign-in__entra">
          <a className="gcpe-button-link" href={entraHref}>
            Sign in with Microsoft
          </a>
        </p>
      )}
      {methods.entra && methods.local && <p className="gcpe-sign-in__or">Or sign in with a password:</p>}
      {methods.local && (
        <Form onSubmit={onSubmit}>
          <TextField label="User name" name="username" value={username} onChange={setUsername} isRequired autoComplete="username" />
          <TextField label="Password" name="password" type="password" value={password} onChange={setPassword} isRequired autoComplete="current-password" />
          <Button type="submit" isDisabled={submitting}>
            Sign in
          </Button>
        </Form>
      )}
    </main>
  );
}
```

In `apps/staff-web/src/styles/global.css`, directly after the `.gcpe-sign-in form { … }` rule, add:

```css
.gcpe-sign-in__entra {
  margin-top: 1rem;
}

.gcpe-sign-in__entra .gcpe-button-link {
  padding: 0.5rem 1rem;
  font-weight: 700;
}

.gcpe-sign-in__or {
  margin: 1.5rem 0 0;
}
```

- [ ] **Step 5: Add the unlink button**

In `apps/staff-web/src/screens/admin/users/UsersScreen.tsx`, inside `UserRow`:

1. After `const [passwordSaved, setPasswordSaved] = useState(false);` add `const [unlinkMessages, setUnlinkMessages] = useState<string[]>([]);`.
2. Directly before `const who = user.email ?? …;` add:

```tsx
  const unlink = async () => {
    setBusy(true);
    setUnlinkMessages([]);
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}/unlink-entra`, { method: "POST" });
      onChanged();
    } catch (caught) {
      setUnlinkMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };
```

3. Replace the `<p className="gcpe-users__sign-in">…</p>` line with:

```tsx
      <p className="gcpe-users__sign-in">Sign-in: {user.signInMethod === "local" ? "Local password" : "Microsoft (Entra)"}</p>
      {user.signInMethod === "entra" && (
        <>
          {unlinkMessages.map((m) => (
            <p role="alert" key={m}>
              {m}
            </p>
          ))}
          <p>Unlinking lets this user sign in with a password set here. Their next Microsoft sign-in links them again by email.</p>
          <Button variant="secondary" onPress={() => void unlink()} isDisabled={busy} aria-label={`Unlink ${who} from Microsoft sign-in`}>
            Unlink Microsoft sign-in
          </Button>
        </>
      )}
```

The existing "Set password" form is already shown only for `signInMethod === "local"`, so it reappears after an unlink.

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run --project staff-web apps/staff-web/src/screens apps/staff-web/src/a11y.test.tsx && npx tsc -p apps/staff-web/tsconfig.json`
Expected: all pass, including the axe check of the sign-in screen. `tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/staff-web/src/screens/SignIn.tsx apps/staff-web/src/screens/SignIn.test.tsx apps/staff-web/src/styles/global.css apps/staff-web/src/screens/admin/users/UsersScreen.tsx apps/staff-web/src/screens/admin/users/UsersScreen.test.tsx
git commit -m "feat(staff-web): Sign in with Microsoft, sign-in error messages, unlink Microsoft sign-in"
```

---
### Task 5: Stack wiring of the fake, end-to-end tests and docs — **lighter review** (but check the two production guards in `usesFakeEntra` carefully)

**Files:**
- Modify: `apps/stack/package.json` (dependency `@gcpe/oidc-fake`), `package-lock.json`
- Modify: `apps/stack/src/env.ts`, `apps/stack/src/stack.ts` (mount)
- Test: `apps/stack/src/fake-entra.test.ts` (new), `tests/siteground-env.test.ts` (one test)
- Modify: `tests/e2e/global-setup.ts`. Create: `tests/e2e/entra-sign-in.spec.ts`
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`

**Interfaces:**
- Consumes: Task 1's `createFakeOidc`. Task 3's `signInSettingsFromEnv` and the Core env keys. Task 4's link and button names.
- Produces: `FAKE_ENTRA_PATH`, `FAKE_ENTRA`, `FAKE_ENTRA_IDENTITIES`, `usesFakeEntra(env)` and `FAKE_ENTRA_CORE_ENV` from `apps/stack/src/env.ts`. The stack setting `FAKE_ENTRA_ENABLED=true`.

- [ ] **Step 1: Write the failing stack tests**

Create `apps/stack/src/fake-entra.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authFromEnv } from "@gcpe/auth";
import { signInSettingsFromEnv } from "../../core/src/entra/config";
import { envFor, FAKE_ENTRA, FAKE_ENTRA_PATH, resolveSelfUrls, usesFakeEntra } from "./env";

const ON = { FAKE_ENTRA_ENABLED: "true", CORE_PUBLIC_BASE_URL: "https://boxs.example.test", STACK_EVENT_SECRET: "e".repeat(40), LOCAL_ADMIN_ENABLED: "true" };

describe("fake Microsoft sign-in", () => {
  it("is off unless FAKE_ENTRA_ENABLED=true, and then Core's view carries nothing of it", () => {
    expect(usesFakeEntra({})).toBe(false);
    expect(usesFakeEntra({ FAKE_ENTRA_ENABLED: "1" })).toBe(false);
    expect(envFor({}, "CORE").ENTRA_CLIENT_ID).toBeUndefined();
    expect(envFor({}, "CORE").ENTRA_TENANT_ID).toBeUndefined();
  });

  it("points Core, and only Core, at the in-process fake", () => {
    const core = resolveSelfUrls(envFor(ON, "CORE"));
    expect(core).toMatchObject({
      ENTRA_TENANT_ID: FAKE_ENTRA.tenantId,
      AUTH_AUDIENCE: FAKE_ENTRA.audience,
      ENTRA_CLIENT_ID: FAKE_ENTRA.clientId,
      ENTRA_AUTHORITY_URL: `http://stack.internal${FAKE_ENTRA_PATH}/${FAKE_ENTRA.tenantId}/v2.0`,
      PUBLIC_BASE_URL: "https://boxs.example.test",
    });
    expect(signInSettingsFromEnv(core).entra).toMatchObject({ authority: `http://stack.internal${FAKE_ENTRA_PATH}/${FAKE_ENTRA.tenantId}/v2.0`, redirectUri: "https://boxs.example.test/core/auth/entra/callback" });
    expect(() => authFromEnv({ ...core, LOCAL_ADMIN_PASSWORD_HASH: undefined, LOCAL_ADMIN_ENABLED: "false" })).not.toThrow();
    for (const prefix of ["NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"] as const) {
      expect(envFor(ON, prefix).ENTRA_TENANT_ID, prefix).toBeUndefined();
      expect(envFor(ON, prefix).ENTRA_CLIENT_ID, prefix).toBeUndefined();
    }
  });

  it("is refused on a real production deployment, allowed on a production-mode test site", () => {
    expect(() => usesFakeEntra({ ...ON, NODE_ENV: "production" })).toThrow("FAKE_ENTRA_ENABLED is refused on a production deployment");
    expect(usesFakeEntra({ ...ON, NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" })).toBe(true);
  });

  it("can't be combined with real Entra settings", () => {
    expect(() => usesFakeEntra({ ...ON, ENTRA_TENANT_ID: "0000fa4e-0000-4000-8000-0000000000aa" })).toThrow("FAKE_ENTRA_ENABLED can't be combined with real Entra settings (ENTRA_TENANT_ID)");
    expect(() => usesFakeEntra({ ...ON, CORE_ENTRA_CLIENT_ID: "real" })).toThrow("(CORE_ENTRA_CLIENT_ID)");
  });
});
```

In `tests/siteground-env.test.ts`, add this test inside `describe("buildEnvLines", …)`, directly before the `CALENDAR_DATABASE_URL` test. It pins boxs.ca's behaviour and passes before and after this task:

```ts
  it("sets no Entra sign-in setting, so a generated site keeps password sign-in", () => {
    const keys = [...parseEnvLines(buildEnvLines(sampleInput(), generateSecrets()).join("\n")).keys()];
    expect(keys.filter((k) => /ENTRA|PUBLIC_BASE_URL|LOCAL_PASSWORDS_ALLOWED/.test(k))).toEqual([]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/stack/src/fake-entra.test.ts tests/siteground-env.test.ts`
Expected: `fake-entra.test.ts` fails (`usesFakeEntra` and `FAKE_ENTRA` aren't exported). `siteground-env.test.ts` passes.

- [ ] **Step 3: Add the fake's constants and guard to the stack env**

In `apps/stack/src/env.ts`, directly before the doc comment `/** What NRMS's env view gets in fake mode: the fake's credentials and its in-process URLs. */`, add:

```ts
/** Where the stack mounts its fake Microsoft sign-in when FAKE_ENTRA_ENABLED=true. */
export const FAKE_ENTRA_PATH = "/fake-entra";

/** The fake's fixed tenant and client: not secrets, made up, and only ever valid against the fake. */
export const FAKE_ENTRA = {
  tenantId: "0000fa4e-0000-4000-8000-000000000000",
  clientId: "fake-entra-core",
  clientSecret: "fake-entra-secret-0123456789",
  audience: "api://fake-entra-core",
} as const;

/** The identities the fake's picker offers. Signing in as one works only where an administrator
 * has created a Core user with that email; none is seeded. */
export const FAKE_ENTRA_IDENTITIES = [
  { key: "staff", oid: "fake-oid-0000-0001", email: "entra-staff@example.test", name: "Entra Test Staff" },
  { key: "unknown", oid: "fake-oid-0000-0002", email: "entra-unknown@example.test", name: "Entra Unknown Person" },
] as const;

/**
 * True when the stack mounts the fake Microsoft sign-in and points Core at it: only when asked
 * for (FAKE_ENTRA_ENABLED=true). Throws on a real production deployment, or when real Entra
 * sign-in settings are present, so the fake can never stand in for Microsoft by accident.
 */
export function usesFakeEntra(env: NodeJS.ProcessEnv): boolean {
  if (env.FAKE_ENTRA_ENABLED !== "true") return false;
  if (env.NODE_ENV === "production" && env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION !== "true") {
    throw new Error("FAKE_ENTRA_ENABLED is refused on a production deployment");
  }
  const real = ["ENTRA_TENANT_ID", "CORE_ENTRA_TENANT_ID", "CORE_ENTRA_CLIENT_ID", "CORE_ENTRA_CLIENT_SECRET", "CORE_ENTRA_AUTHORITY_URL"].filter((k) => env[k]);
  if (real.length > 0) throw new Error(`FAKE_ENTRA_ENABLED can't be combined with real Entra settings (${real.join(", ")})`);
  return true;
}

/** What Core's env view gets in fake mode: the fake's tenant, client and in-process issuer.
 * AUTH_AUDIENCE comes along because authFromEnv needs one whenever ENTRA_TENANT_ID is set. */
export const FAKE_ENTRA_CORE_ENV: Readonly<Record<string, string>> = {
  ENTRA_TENANT_ID: FAKE_ENTRA.tenantId,
  AUTH_AUDIENCE: FAKE_ENTRA.audience,
  ENTRA_CLIENT_ID: FAKE_ENTRA.clientId,
  ENTRA_CLIENT_SECRET: FAKE_ENTRA.clientSecret,
  ENTRA_AUTHORITY_URL: `self:${FAKE_ENTRA_PATH}/${FAKE_ENTRA.tenantId}/v2.0`,
};
```

In `envFor`, directly after the line `if (prefix === "NOD" && usesFakeEmergencyFeed(env)) Object.assign(view, FAKE_EMERGENCY_FEED_ENV);`, add:

```ts
  // FAKE_ENTRA_ENABLED on a test site → Core signs staff in through the stack's fake Microsoft.
  if (prefix === "CORE" && usesFakeEntra(env)) Object.assign(view, FAKE_ENTRA_CORE_ENV);
```

`resolveSelfUrls` already turns `ENTRA_AUTHORITY_URL=self:/…` into `http://stack.internal/…`, because the name ends in `_URL`.

- [ ] **Step 4: Mount the fake in the stack**

In `apps/stack/package.json`, add `"@gcpe/oidc-fake": "0.0.0",` after `"@gcpe/media-hub-fake"`, then run `npm install`.

In `apps/stack/src/stack.ts`:

1. Add `import { createFakeOidc } from "@gcpe/oidc-fake";` after the `@gcpe/media-hub-fake` import.
2. Add `FAKE_ENTRA, FAKE_ENTRA_IDENTITIES, FAKE_ENTRA_PATH,` to the `./env` import (after `FAKE_EMERGENCY_FEED_PATH,`) and `usesFakeEntra,` (after `usesFakeEmergencyFeed,`).
3. Directly before the comment `// One combined login-attempt budget (10/min/IP)…`, after the emergency-feed block, add:

```ts
  // FAKE_ENTRA_ENABLED=true on a test site → a fake Microsoft sign-in that Core's env view already
  // points at (envFor; see usesFakeEntra). Core reaches it in-process; the browser reaches its
  // picker under CORE_PUBLIC_BASE_URL. It offers only FAKE_ENTRA_IDENTITIES.
  if (usesFakeEntra(env)) {
    console.warn(`[stack] ENTRA: using the FAKE Microsoft sign-in at ${FAKE_ENTRA_PATH} — test sites only`);
    const publicOrigin = new URL(coreEnv.PUBLIC_BASE_URL!).origin;
    const fakeEntra = await createFakeOidc({
      tenantId: FAKE_ENTRA.tenantId,
      clientId: FAKE_ENTRA.clientId,
      clientSecret: FAKE_ENTRA.clientSecret,
      redirectUris: [`${publicOrigin}/core/auth/entra/callback`],
      serverBase: `${INTERNAL_ORIGIN}${FAKE_ENTRA_PATH}`,
      browserBase: `${publicOrigin}${FAKE_ENTRA_PATH}`,
      identities: [...FAKE_ENTRA_IDENTITIES],
    });
    app.use(FAKE_ENTRA_PATH, fakeEntra.router);
  }
```

`coreEnv.PUBLIC_BASE_URL` is always set here: in fake mode Core's view has `ENTRA_CLIENT_ID`, so `startCore` has already thrown `missing PUBLIC_BASE_URL` if it were absent.

Run: `npx vitest run apps/stack/src/fake-entra.test.ts apps/stack/src/env.test.ts apps/stack/src/stack-check.test.ts && npx tsc -p tsconfig.json`
Expected: all pass. `tsc` prints nothing.

- [ ] **Step 5: End-to-end through the fake**

In `tests/e2e/global-setup.ts`, in the `env` object, directly after `STAFF_WEB_DIR: staffWebDir,`, add:

```ts
    // Entra sign-in through the stack's fake Microsoft (entra-sign-in.spec.ts): the browser
    // reaches the fake's picker and Core's callback at this origin.
    FAKE_ENTRA_ENABLED: "true",
    CORE_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
```

Create `tests/e2e/entra-sign-in.spec.ts`:

```ts
// Entra staff sign-in (docs/superpowers/specs/2026-10-12-entra-staff-sign-in-design.md),
// through the stack's fake Microsoft sign-in (FAKE_ENTRA_ENABLED in global-setup.ts).
import { test, expect } from "@playwright/test";
import { FAKE_ENTRA_IDENTITIES } from "../../apps/stack/src/env";
import { apiCall, baseUrl, ROLE_LOGINS, signInAs } from "./playwright-support";

const [STAFF, UNKNOWN] = FAKE_ENTRA_IDENTITIES;

test.describe("Sign in with Microsoft", () => {
  test("a provisioned user lands in the staff app with their Core roles, and an admin can unlink them", async ({ page, browser }) => {
    await apiCall(await ROLE_LOGINS.admin(), "/core/api/users", { method: "POST", body: { email: STAFF.email, displayName: STAFF.name, roles: ["NRMS.Editor"] } });

    await page.goto(`${baseUrl()}/hub/sign-in`);
    await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
    await expect(page.getByRole("heading", { name: "Fake Microsoft sign-in" })).toBeVisible();
    await page.getByRole("link", { name: `${STAFF.name} (${STAFF.email})` }).click();

    await expect(page).toHaveURL(/\/hub\/releases\/drafts$/);
    await expect(page.getByText(`Signed in as ${STAFF.name}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "New release" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

    const adminContext = await browser.newContext();
    await signInAs(adminContext, "admin");
    const admin = await adminContext.newPage();
    await admin.goto(`${baseUrl()}/hub/users`);
    const row = admin.getByRole("listitem").filter({ has: admin.getByRole("heading", { name: STAFF.email, level: 3 }) });
    await expect(row.getByText("Sign-in: Microsoft (Entra)")).toBeVisible();
    await row.getByRole("button", { name: `Unlink ${STAFF.email} from Microsoft sign-in` }).click();
    await expect(row.getByText("Sign-in: Local password")).toBeVisible();
    await adminContext.close();
  });

  test("someone without a Core account is told to contact an administrator", async ({ page }) => {
    await page.goto(`${baseUrl()}/hub/sign-in`);
    await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
    await page.getByRole("link", { name: `${UNKNOWN.name} (${UNKNOWN.email})` }).click();
    await expect(page).toHaveURL(/\/hub\/sign-in\?error=not_provisioned$/);
    await expect(page.getByRole("alert")).toHaveText("Your account hasn't been set up. Contact an administrator.");
  });
});
```

Run: `npx playwright test tests/e2e/entra-sign-in.spec.ts tests/e2e/sign-in-roles.spec.ts && npx playwright test tests/e2e/axe-sweep.spec.ts -g "sign-in"`
Expected: 7 passed, then 1 passed. The setup log shows `[stack] ENTRA: using the FAKE Microsoft sign-in at /fake-entra — test sites only`. The run prints one `[core] entra sign-in refused route=/auth/entra/callback code=not_provisioned` line, from the second spec.

- [ ] **Step 6: Docs: parity, running notes, runbook**

Check that the numbers are free first: `grep -c "^| C210 " docs/parity/changes-from-legacy.md` and `grep -c "^| Q89 " docs/parity/open-questions.md` must both print `0`. At HEAD the highest numbers are C209 and Q88.

In `docs/parity/changes-from-legacy.md`, add this row to the "Sign-in, users and roles" table, directly after the `| C2 |` row:

```markdown
| C210 | Hub staff signed in with Windows/AD authentication. | Staff sign in with their government Microsoft account through Entra OIDC (authorization code with PKCE); Core holds the roles. Someone without a Core account is refused until an administrator creates one. Local passwords stay for test sites and the break-glass administrator. | Legacy's Windows authentication depends on government infrastructure the platform can't run; Entra is the government's identity provider, and keeping roles in Core keeps one place to manage access. | Agreed |
```

In `docs/parity/open-questions.md`, add this row to the "Open" table, directly after the `| Q88 |` row:

```markdown
| Q89 | Should administrators get a list of access requests: people who signed in with Microsoft but have no Core account? | Unknown identities are refused (an administrator creates every user first); without a list, an administrator only hears about it when the person gets in touch. | No list. The sign-in screen tells the person to contact an administrator, who creates them in Core; the refusal is logged with no name or email. | 2026-10-12 |
```

Append to `docs/manuals/running-notes.md`:

```markdown
## Entra staff sign-in

- **Editor**, **Site editor**, **Viewer** — "Sign in with Microsoft" signs you in with your government Microsoft account. You need a Core account first: if the screen says "Your account hasn't been set up", ask an administrator to create you. Signing out of the staff app doesn't sign you out of Microsoft.
- **Administrator** — Create the user in Users with their government email before they first sign in with Microsoft. Their first Microsoft sign-in links the account (Users then shows "Sign-in: Microsoft (Entra)") and their password stops working.
- **Administrator** — "Unlink Microsoft sign-in" on a user forgets their Microsoft account and returns them to "Local password", so a password can be set again. Their next Microsoft sign-in links them again by email. Use it when someone's Microsoft account was replaced, or when sign-in says "Your account needs an administrator to check it" (the email is linked to a different Microsoft account): unlink, then have them sign in again.
- **Operations** — In production with Entra sign-in on, user passwords are refused unless `CORE_LOCAL_PASSWORDS_ALLOWED=true`. The break-glass administrator (`LOCAL_ADMIN_*`) is unaffected.
- **Developer** — `FAKE_ENTRA_ENABLED=true` (tests and test sites only) mounts a fake Microsoft sign-in at `/fake-entra` with two made-up identities, `entra-staff@example.test` and `entra-unknown@example.test`. It needs `CORE_PUBLIC_BASE_URL` and is refused in production and alongside real Entra settings.
```

In `docs/deploy/siteground.md`, add this section directly before `## Flickr (Phase 3c)`:

```markdown
## Staff sign-in with Microsoft Entra

Staff can sign in with their government Microsoft account. It is **off** unless configured: boxs.ca sets none of these settings and keeps password sign-in exactly as before (`npm run siteground:env` never generates them).

**Entra app registration** (for the Entra administrator):

- Platform: **Web**. Redirect URI, exactly: **`https://boxs.ca/core/auth/entra/callback`** on boxs.ca; elsewhere `<CORE_PUBLIC_BASE_URL>/core/auth/entra/callback`, for example `https://news.example.gov.bc.ca/core/auth/entra/callback`.
- Supported account types: this organization only (single tenant).
- A client secret.
- Delegated permissions `openid`, `profile` and `email` (Microsoft Graph). No app roles or groups: roles stay in Core.
- No front-channel logout URL: signing out of the staff app doesn't sign anyone out of Microsoft.

**Settings:**

| Setting | Value |
|---|---|
| `ENTRA_TENANT_ID` | The tenant id (shared by every app). |
| `CORE_ENTRA_CLIENT_ID` | The app registration's client id. |
| `CORE_ENTRA_CLIENT_SECRET` | Its client secret. |
| `CORE_PUBLIC_BASE_URL` | The site's origin, e.g. `https://boxs.ca`: https, no path. The redirect URI is this plus `/core/auth/entra/callback`. |
| `CORE_LOCAL_PASSWORDS_ALLOWED` | Optional. In production (`NODE_ENV=production`) with Entra on, user passwords are refused unless this is `true`. The break-glass admin isn't affected. |

Entra sign-in is on when `CORE_ENTRA_CLIENT_ID`, `CORE_ENTRA_CLIENT_SECRET` or `CORE_PUBLIC_BASE_URL` is set. Setting only some of them fails at startup and in `node stack.js --check`, naming what's missing. `SESSION_SECRET` is needed too; on the stack it is derived from `STACK_EVENT_SECRET`.

**Setting `ENTRA_TENANT_ID` on the stack also turns on Entra token checks in every app**, so each app then needs its `<PREFIX>_AUTH_AUDIENCE` (`CORE_`, `NRMS_`, `NEWSAPI_`, `SITE_`, `NOD_`, `DIST_`, and `CALENDAR_` when the Calendar runs). `--check` names any that are missing.

**Who can sign in.** Only people who already have an active Core user with the same email. The first sign-in links the user to their Microsoft account (Users shows "Sign-in: Microsoft (Entra)"), and their password stops working. "Unlink Microsoft sign-in" on the Users screen undoes that. Anyone else sees "Your account hasn't been set up. Contact an administrator."

**Troubleshooting.** Staff must start sign-in on the `CORE_PUBLIC_BASE_URL` host: a sign-in started on another host (say `www.` when the setting has none) can't read its state cookie at the callback and ends with "Your sign-in took too long". Refusals are logged as `[core] entra sign-in refused route=… code=… user=…`, with no names, emails or tokens. `code=failed` and `code=conflict` also go to the error log (`/hub/error-log`); `failed` carries an `error=` label such as `OAUTH_JWT_CLAIM_COMPARISON_FAILED` or `wrong_tenant`.

**Fake Microsoft sign-in (test sites only).** `FAKE_ENTRA_ENABLED=true` plus `CORE_PUBLIC_BASE_URL` mounts a fake at `/fake-entra` and points Core at it. Its picker offers two made-up identities, `entra-staff@example.test` and `entra-unknown@example.test`; create a Core user with the first email to try a successful sign-in. **Anyone who can reach the site can then sign in as that user without a password**, so enable it only while testing and give that user no more roles than the test needs. The stack refuses it in production and alongside any real Entra setting.
```

- [ ] **Step 7: Whole-suite check and the SiteGround bundle**

Run: `npm run check && npx vitest run`
Expected: `tsc` clean. At HEAD plus this plan: about 5,070 tests pass and 10 are skipped, 0 fail. That includes the unchanged v1 News API compatibility suites.

Run: `npm run build:siteground`
Expected: `[build-siteground] OK — artifact at …/dist/siteground`. openid-client and the fake are bundled into `stack.js`.

Run: `npm run test:e2e`
Expected: the whole Playwright suite passes. The fake is on for the whole suite, and other specs never use the Microsoft link.

- [ ] **Step 8: Commit**

```bash
git add apps/stack/package.json package-lock.json apps/stack/src/env.ts apps/stack/src/stack.ts apps/stack/src/fake-entra.test.ts tests/siteground-env.test.ts tests/e2e/global-setup.ts tests/e2e/entra-sign-in.spec.ts docs/parity/changes-from-legacy.md docs/parity/open-questions.md docs/manuals/running-notes.md docs/deploy/siteground.md
git commit -m "feat(stack): fake Microsoft sign-in for test sites; Entra e2e; runbook, parity C210/Q89 and running notes"
```

---

## Self-review notes (planner)

- **Spec coverage:** §3 flow → Task 3. §4 matching, password refusal and unlink → Tasks 2 and 4. §5 configuration, startup check, `--check` and `/auth/methods` → Task 3. §6 codes, messages and logging → Tasks 3 and 4. §7 fake → Task 1; the unit and integration list → Tasks 2 and 3; end-to-end → Task 5. §8 docs → Task 5. Out of scope: no user auto-creation, no Entra roles, no Microsoft sign-out.
- **Verified at HEAD 04814f1 by dry run** (then reverted): every file above compiled (`npm run check`); `npx vitest run` passed 5,065 tests with 10 skipped (before the two concurrency tests were added); the five e2e checks passed through the real stack; and `npm run build:siteground` succeeded.
