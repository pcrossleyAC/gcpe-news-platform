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
}

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
    let cached: { token: string; expiresAt: number } | undefined;
    return async () => {
      const now = (opts.now ?? Date.now)();
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.token;
      const token = await mintLocalToken({
        secret: local.secret,
        subject: "nod",
        azp: "nod",
        roles: ["Distribution.Send"],
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
