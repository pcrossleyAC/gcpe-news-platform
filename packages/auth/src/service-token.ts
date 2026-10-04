import { createClientCredentialsProvider } from "./client-credentials";
import { mintLocalToken, type LocalAuthConfig } from "./local";

const LOCAL_TOKEN_TTL_SECONDS = 3600;
// Re-mint once fewer than 5 minutes remain, mirroring createClientCredentialsProvider's own
// (60s) early-refresh margin in spirit — just sized for this token's much longer TTL.
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ServiceTokenOptions {
  /** All four must be set together to use Entra client credentials; otherwise none of them
   * should be set (checked below) and the local branch is tried instead. */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** `authFromEnv(env).local` — non-null only when LOCAL_ADMIN_ENABLED=true. */
  local: LocalAuthConfig | null;
  /** The local token's `sub` and `azp` claim. */
  subject: string;
  /** The local token's `roles` claim. */
  roles: string[];
  /** Env var name prefix used in the error messages below (e.g. "NOD" for
   * `NOD_TOKEN_URL`/`NOD_CLIENT_ID`/`NOD_CLIENT_SECRET`/`NOD_SCOPE`). */
  envPrefix: string;
  fetchImpl?: typeof fetch;
  /** Clock override for tests; defaults to the wall clock. */
  now?: () => number;
  /** Test injection point for the local branch's token minting, so a test can count calls
   * (distinguishing "returned the cached token" from "minted a fresh one, which happened to
   * come out identical") without decoding JWTs to guess. Defaults to the real
   * {@link mintLocalToken}. */
  mintToken?: typeof mintLocalToken;
}

/**
 * Generalised form of NoD's own `distributionTokenProvider` (apps/nod/src/distribution-token.ts),
 * shared so any service that needs to authenticate its own calls to another internal service can
 * pick the same way: Entra client credentials win when fully configured; failing that, a local
 * admin secret (test/non-prod environments) mints a short-lived local token instead, carrying the
 * caller's own `subject`/`roles`; with neither available this throws immediately, so a
 * misconfigured deployment fails at startup rather than on the first call.
 */
export function serviceTokenProvider(opts: ServiceTokenOptions): () => Promise<string> {
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
      `service token: set ${opts.envPrefix}_TOKEN_URL, ${opts.envPrefix}_CLIENT_ID, ${opts.envPrefix}_CLIENT_SECRET and ${opts.envPrefix}_SCOPE together, or none of them`,
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
        subject: opts.subject,
        azp: opts.subject,
        roles: opts.roles,
        ttlSeconds: LOCAL_TOKEN_TTL_SECONDS,
        now: opts.now,
      });
      cached = { token, expiresAt: now + LOCAL_TOKEN_TTL_SECONDS * 1000 };
      return token;
    };
  }

  throw new Error(
    `service token: configure ${opts.envPrefix}_TOKEN_URL/CLIENT_ID/CLIENT_SECRET/SCOPE (Entra), or enable LOCAL_ADMIN_ENABLED (test environments)`,
  );
}
