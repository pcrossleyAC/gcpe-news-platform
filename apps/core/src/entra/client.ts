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
