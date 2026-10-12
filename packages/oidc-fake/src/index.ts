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
  /** Absolute unix-seconds `exp`, in place of the default `iat + 3600`. Lets a test send an
   * already-expired ID token. */
  exp?: number;
  /** Leaves the `oid` claim out of the token entirely, in place of the identity's own oid. */
  omitOid?: boolean;
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
// A test site's fake is reachable by anyone, unauthenticated and with no rate limit, so an
// unredeemed or expired code must not grow this map without bound. Pruned on every approve, and
// capped so even a burst of never-redeemed codes within one TTL window can't exceed this.
const MAX_PENDING_CODES = 1000;
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

  /** Drops every expired code, then, if still at the cap, the single oldest (Map iterates in
   * insertion order) — called before each new code is issued, the map's only growth point. */
  function sweepPendingCodes(now: number): void {
    for (const [code, pending] of codes) {
      if (pending.expiresAt < now) codes.delete(code);
    }
    if (codes.size >= MAX_PENDING_CODES) {
      const oldest = codes.keys().next().value;
      if (oldest !== undefined) codes.delete(oldest);
    }
  }

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
    const now = Date.now();
    sweepPendingCodes(now);
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { identity, redirectUri: a.redirectUri, challenge: a.challenge, nonce: a.nonce, expiresAt: now + CODE_TTL_MS });
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
      ...(t.omitOid ? {} : { oid: pending.identity.oid }),
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
      .setExpirationTime(t.exp ?? now + 3600)
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
