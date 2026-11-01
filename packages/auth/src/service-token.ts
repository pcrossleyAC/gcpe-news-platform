import { createClientCredentialsProvider } from "./client-credentials";
import { INTERNAL_TOKEN_TTL_SECONDS, isInternalUrl, mintInternalToken } from "./internal";
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
  /** `authFromEnv(env).internal` — the stack's own app-to-app key (internal.ts). Used only when
   * {@link targetUrl} is served in-process by the stack, so it is never sent anywhere else. */
  internal?: { secret: string } | null;
  /** The base URL this token is for, as the client will call it (self: URLs already resolved). */
  targetUrl?: string;
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

/** A cached getToken over `mint`, re-minting once fewer than REFRESH_MARGIN_MS remain. */
function cachedMint(ttlSeconds: number, now: () => number, mint: () => Promise<string>): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    const at = now();
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > at) return cached.token;
    const token = await mint();
    cached = { token, expiresAt: at + ttlSeconds * 1000 };
    return token;
  };
}

/**
 * How any app authenticates its own calls to another app, picked once at startup:
 * 1. Entra client credentials, when all four settings are set (apps split across processes or
 *    servers: production configuration T8, not built);
 * 2. the stack's internal token (owner decision 2026-10-31, T2), when the target is served
 *    in-process — the normal case in every deployment, break-glass on or off;
 * 3. a local token signed with the break-glass admin's secret (an app run on its own in dev and
 *    tests, with no stack around it);
 * 4. otherwise it throws, so a misconfigured deployment fails at startup, not on the first call.
 * Every branch but Entra carries the caller's own `subject` (also its azp) and `roles`.
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

  const now = opts.now ?? Date.now;
  if (opts.internal && isInternalUrl(opts.targetUrl)) {
    const secret = opts.internal.secret;
    return cachedMint(INTERNAL_TOKEN_TTL_SECONDS, now, () => mintInternalToken({ secret, subject: opts.subject, roles: opts.roles, now: opts.now }));
  }

  if (opts.local) {
    const local = opts.local;
    const mint = opts.mintToken ?? mintLocalToken;
    return cachedMint(LOCAL_TOKEN_TTL_SECONDS, now, () =>
      mint({ secret: local.secret, subject: opts.subject, azp: opts.subject, roles: opts.roles, ttlSeconds: LOCAL_TOKEN_TTL_SECONDS, now: opts.now }),
    );
  }

  throw new Error(
    `service token: configure ${opts.envPrefix}_TOKEN_URL/CLIENT_ID/CLIENT_SECRET/SCOPE (Entra)${opts.targetUrl && !isInternalUrl(opts.targetUrl) ? " for this outside service" : ", run it inside the stack (STACK_EVENT_SECRET)"}, or enable LOCAL_ADMIN_ENABLED (test environments)`,
  );
}
