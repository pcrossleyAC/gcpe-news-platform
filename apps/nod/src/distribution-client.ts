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
 * back off and try again (network error, 429, or any 5xx) or fail the job immediately (any
 * other 4xx — a request that will never succeed as-is, e.g. a validation error).
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
  /** Bounds a single request (AbortSignal.timeout); also used by send-jobs.ts to size its
   * claim lock, since a hung request must not outlive the lock it's running under. */
  timeoutMs?: number;
}

export interface DistributionClient {
  send(req: MessageRequest): Promise<{ batchId: string }>;
}

export function distributionClient(opts: DistributionClientOptions): DistributionClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISTRIBUTION_TIMEOUT_MS;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/messages`;

  return {
    async send(req: MessageRequest): Promise<{ batchId: string }> {
      const token = await opts.getToken();
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

      if (res.status === 200 || res.status === 202) {
        const json = (await res.json()) as { batchId: string };
        return { batchId: json.batchId };
      }

      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      throw new DistributionError(`Distribution responded HTTP ${res.status}${body ? `: ${body}` : ""}`, retryable, res.status);
    },
  };
}
