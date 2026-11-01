import { serviceTokenProvider, type mintLocalToken, type LocalAuthConfig } from "@gcpe/auth";

export interface DistributionTokenOptions {
  /** All four must be set together to use Entra client credentials; otherwise none of them
   * should be set (checked below) and the local branch is tried instead. */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** `authFromEnv(process.env).local` — non-null only when LOCAL_ADMIN_ENABLED=true. */
  local: LocalAuthConfig | null;
  /** `authFromEnv(env).internal`: the stack's own app-to-app key, used when {@link targetUrl} is in-process. */
  internal?: { secret: string } | null;
  /** Distribution's base URL as NoD calls it (self: already resolved). */
  targetUrl?: string;
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
 * Picks how NoD authenticates its own calls to Distribution, and returns a cached `getToken()`:
 * @gcpe/auth's serviceTokenProvider (Entra client credentials, else the stack's internal token for
 * an in-process Distribution, else the break-glass secret, else it throws at startup), always as
 * subject and azp "nod" with Distribution.Send and Distribution.Operate (the pause switch).
 */
export function distributionTokenProvider(opts: DistributionTokenOptions): () => Promise<string> {
  return serviceTokenProvider({ ...opts, subject: "nod", roles: ["Distribution.Send", "Distribution.Operate"], envPrefix: "DISTRIBUTION" });
}
