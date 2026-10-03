// Distribution's own contract (apps/distribution/src/messages.ts) isn't imported directly —
// these two services only share an HTTP boundary, not a TypeScript one — so the request shape
// is mirrored here as a plain type.
export interface MessageRecipient {
  email: string;
  substitutions: Record<string, string>;
}

export interface MessageRequest {
  priority: "system" | "media" | "immediate" | "digest";
  idempotencyKey?: string;
  subject: string;
  html: string;
  text?: string;
  headers: Record<string, string>;
  recipients: MessageRecipient[];
}

/**
 * Thrown by {@link distributionClient}'s `send`. `retryable` tells send-jobs.ts whether to
 * back off and try again, or fail the job immediately. Retryable: a network error, our own
 * getToken or request timeout firing, 429, any 5xx, a malformed/unreadable 2xx body (P2-R16 —
 * we can't tell whether Distribution actually accepted the batch, so assuming it didn't is
 * the safe default since the idempotency key makes a retry harmless either way), and 401/403
 * (P2-R16 — a credentials problem is usually transient — a token that hadn't propagated yet,
 * a clock skew, a brief outage at the token issuer — and failing the job outright over it
 * would need a human to notice the dead job and resubmit it; logged loudly instead, see
 * distributionClient). Not retryable: any other 4xx (400/422/…) — a request that is wrong as
 * written and will never succeed by merely trying again.
 */
export class DistributionError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "DistributionError";
    this.retryable = retryable;
    this.status = status;
  }
}

export const DEFAULT_DISTRIBUTION_TIMEOUT_MS = 30_000;

export interface DistributionClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Bounds a single request (AbortSignal.timeout) *and* a single getToken() call (P2-R16);
   * also used by send-jobs.ts to size its claim lock, since a hung request or token fetch
   * must not outlive the lock it's running under. */
  timeoutMs?: number;
}

export interface DistributionClient {
  send(req: MessageRequest): Promise<{ batchId: string }>;
}

/** Races `getToken()` against a timer so a hung token endpoint can't hang `send` forever —
 * mirrors the request's own `AbortSignal.timeout` below, just via Promise.race since
 * `getToken` (an opaque async function, possibly cached/synchronous-ish) has no signal to
 * pass a deadline into. */
function getTokenWithTimeout(getToken: () => Promise<string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    getToken().then(
      (token) => {
        clearTimeout(timer);
        resolve(token);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function distributionClient(opts: DistributionClientOptions): DistributionClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISTRIBUTION_TIMEOUT_MS;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/messages`;

  return {
    async send(req: MessageRequest): Promise<{ batchId: string }> {
      let token: string;
      try {
        token = await getTokenWithTimeout(opts.getToken, timeoutMs);
      } catch (e) {
        // P2-R16: a failure getting a token (the endpoint is down, times out, returns an
        // error, …) is treated the same as a network error below — retryable, since the
        // request to Distribution itself was never even attempted.
        const message = e instanceof Error ? e.message : String(e);
        throw new DistributionError(`failed to get a Distribution token: ${message}`, true);
      }

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // Network error (connection refused, DNS failure, our own timeout firing, …): we
        // cannot know whether Distribution ever saw the request, but the idempotency key
        // means a retry is always safe.
        const message = e instanceof Error ? e.message : String(e);
        throw new DistributionError(`request to Distribution failed: ${message}`, true);
      }

      if (res.ok) {
        try {
          const json = (await res.json()) as { batchId: string };
          return { batchId: json.batchId };
        } catch (e) {
          // P2-R16: Distribution said success but the body couldn't be read/parsed — we can't
          // learn the batchId, but we also can't be sure Distribution didn't accept the
          // batch, so treat this as retryable rather than silently losing it as a failure.
          const message = e instanceof Error ? e.message : String(e);
          throw new DistributionError(`Distribution returned HTTP ${res.status} but its body was unreadable: ${message}`, true, res.status);
        }
      }

      const body = await res.text().catch(() => "");
      let retryable = res.status === 429 || res.status >= 500;
      if (res.status === 401 || res.status === 403) {
        retryable = true;
        console.error("[nod] Distribution rejected our credentials (401/403) — check token config");
      }
      throw new DistributionError(`Distribution responded HTTP ${res.status}${body ? `: ${body}` : ""}`, retryable, res.status);
    },
  };
}
