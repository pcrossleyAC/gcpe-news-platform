import { createClientCredentialsProvider, mintLocalToken, type LocalAuthConfig } from "@gcpe/auth";

const LOCAL_TOKEN_TTL_SECONDS = 3600;
// Re-mint once fewer than 5 minutes remain, mirroring createClientCredentialsProvider's own
// (60s) early-refresh margin in spirit — just sized for this token's much longer TTL.
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface DistributionTokenOptions {
  /** All four must be set together to use Entra client credentials; otherwise none of them
   * should be set (checked below) and the local branch is tried instead. */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** `authFromEnv(process.env).local` — non-null only when LOCAL_ADMIN_ENABLED=true. */
  local: LocalAuthConfig | null;
  fetchImpl?: typeof fetch;
  /** Clock override for tests; defaults to the wall clock. */
  now?: () => number;
  /** Test injection point for the local branch's token minting, so a test can count calls
   * (distinguishing "returned the cached token" from "minted a fresh one, which happened to
   * come out identical") without decoding JWTs to guess. Defaults to the real
   * {@link mintLocalToken}. */
  mintToken?: typeof mintLocalToken;
}

// P2-R16 / Task 12 note: Distribution scopes idempotency (and every batch's appId) by the
// calling token's `azp`. Both the Entra and local branches here always mint with the same
// identity ("nod" for local; the Entra client id for client-credentials), but if an operator
// ever needs to switch *which* branch is active (e.g. flipping from a local token to Entra in
// a given environment), that switch must not happen while any send_jobs are mid-retry: a
// retry after the switch would carry a different azp than the attempt(s) before it, so
// Distribution would see it as a different app and never dedupe against the batches the old
// identity already got accepted — silently double-sending every chunk that had already
// succeeded under the old token.

/**
 * Picks how NoD authenticates its own calls to Distribution, and returns a cached
 * `getToken()`. Entra client credentials win when fully configured; failing that, a local
 * admin secret (test/non-prod environments) mints a short-lived local token instead; with
 * neither available this throws immediately, so a misconfigured deployment fails at startup
 * rather than on the first send.
 */
export function distributionTokenProvider(opts: DistributionTokenOptions): () => Promise<string> {
  const entraFields = [opts.tokenUrl, opts.clientId, opts.clientSecret, opts.scope];
  const entraFieldsGiven = entraFields.filter((v) => v !== undefined && v !== "").length;

  if (entraFieldsGiven === 4) {
    return createClientCredentialsProvider({
      tokenUrl: opts.tokenUrl!,
      clientId: opts.clientId!,
      clientSecret: opts.clientSecret!,
      scope: opts.scope!,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    });
  }
  if (entraFieldsGiven > 0) {
    throw new Error(
      "distribution token: set DISTRIBUTION_TOKEN_URL, DISTRIBUTION_CLIENT_ID, DISTRIBUTION_CLIENT_SECRET and DISTRIBUTION_SCOPE together, or none of them",
    );
  }

  if (opts.local) {
    const local = opts.local;
    const mint = opts.mintToken ?? mintLocalToken;
    let cached: { token: string; expiresAt: number } | undefined;
    return async () => {
      const now = (opts.now ?? Date.now)();
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.token;
      const token = await mint({
        secret: local.secret,
        subject: "nod",
        azp: "nod",
        // Distribution.Operate lets this same token control Distribution's pause switch,
        // alongside the existing message-sending role.
        roles: ["Distribution.Send", "Distribution.Operate"],
        ttlSeconds: LOCAL_TOKEN_TTL_SECONDS,
      });
      cached = { token, expiresAt: now + LOCAL_TOKEN_TTL_SECONDS * 1000 };
      return token;
    };
  }

  throw new Error(
    "distribution token: configure DISTRIBUTION_TOKEN_URL/CLIENT_ID/CLIENT_SECRET/SCOPE (Entra), or enable LOCAL_ADMIN_ENABLED (test environments)",
  );
}
