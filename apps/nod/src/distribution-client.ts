import { z } from "zod";

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
  /** Beats DistributionClientOptions.replyTo (NoD's REPLY_TO) when a particular send wants its
   * own; omitted here, {@link distributionClient}'s `send` fills in the configured one. */
  replyTo?: string;
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
  /** NoD's own REPLY_TO, applied to every send whose request doesn't already carry its own
   * `replyTo` — so every caller (As-It-Happens, digest, emergency, media, system emails, ops
   * emails) gets it without each one having to set it. */
  replyTo?: string;
}

export interface DistributionClient {
  send(req: MessageRequest): Promise<{ batchId: string }>;
  /** The Distribution-wide pause switch's current state (its own `GET /api/settings`),
   * gated on Distribution.Operate — never called with a staff credential, only with NoD's
   * own Distribution service token. */
  getSettings(): Promise<{ paused: boolean }>;
  /** Pauses or resumes Distribution as a whole (`POST /api/settings/pause|resume`).
   * `changed` is false when Distribution was already in the requested state — NoD's own
   * setDistributionPaused (settings.ts) uses that to skip its operations_log row and ops
   * email on a repeat call. */
  setPaused(paused: boolean): Promise<{ paused: boolean; changed: boolean }>;
  /** Proxies one raw bounce report into Distribution's fake inbox (`POST /api/bounces/inbox`,
   * gated there on `Distribution.Operate` — the same role this client's own token carries).
   * Distribution 404s this when it isn't running in fake mode; that 404 is non-retryable (see
   * callDistribution's 4xx handling) and NoD's own route (http/routes.ts) maps it to its own
   * 404 for the caller, rather than the generic 502 every other DistributionError gets. */
  uploadBounce(raw: string): Promise<{ id: string }>;
  /** The daily bounce summary's own counts Distribution alone can answer — bounces that never
   * matched a message NoD sent, and messages that weren't bounces at all (`GET
   * /api/bounces/stats?since=`, gated on `Distribution.Operate`). `since` is an ISO instant. */
  bounceStats(since: string): Promise<{ unmatched: number; ignored: number }>;
}

// P2-R18: Distribution's 2xx body is network input like any other — `res.json()` succeeding
// only proves the bytes were valid JSON, not that they have the shape we need. A body that
// parses but is missing `batchId` (or has it as `""`, or a non-string) must fail the same way
// an unparseable body does: retryable, since send-jobs.ts stores whatever `batchId` comes
// back as *the* record of this chunk's acceptance, and a bad id poisons that permanently.
const batchResponseSchema = z.object({ batchId: z.string().min(1) });
const settingsResponseSchema = z.object({ paused: z.boolean() });
const pauseResponseSchema = z.object({ paused: z.boolean(), changed: z.boolean() });
const uploadBounceResponseSchema = z.object({ id: z.string().min(1) });
const bounceStatsResponseSchema = z.object({ unmatched: z.number().int().nonnegative(), ignored: z.number().int().nonnegative() });

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

/**
 * One authenticated JSON round trip to Distribution, shared by every `DistributionClient`
 * method below (`send`, `getSettings`, `setPaused`) — token fetch, the request itself, and the
 * 2xx/4xx/5xx -> DistributionError mapping are identical for all three; only the path, method,
 * body and response shape differ per call. `invalidShapeMessage` lets `send` keep its own
 * long-standing wording ("Distribution response missing batchId") that send-jobs.ts/its tests
 * already match on.
 */
async function callDistribution<T>(
  opts: DistributionClientOptions,
  doFetch: typeof fetch,
  timeoutMs: number,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  schema: z.ZodType<T>,
  invalidShapeMessage: string,
): Promise<T> {
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

  const url = `${opts.baseUrl.replace(/\/+$/, "")}${path}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: init.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      // P2-R16: Distribution said success but the body couldn't be read/parsed — we can't
      // learn the result, but we also can't be sure Distribution didn't accept the call, so
      // treat this as retryable rather than silently losing it as a failure.
      const message = e instanceof Error ? e.message : String(e);
      throw new DistributionError(`Distribution returned HTTP ${res.status} but its body was unreadable: ${message}`, true, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // P2-R18: the body parsed as JSON but doesn't have the shape we need — same reasoning
      // as the unreadable-body case above: can't be sure Distribution didn't accept the call,
      // so retryable rather than a silent, permanent data-loss failure.
      throw new DistributionError(invalidShapeMessage, true, res.status);
    }
    return parsed.data;
  }

  const body = await res.text().catch(() => "");
  let retryable = res.status === 429 || res.status >= 500;
  if (res.status === 401 || res.status === 403) {
    retryable = true;
    console.error("[nod] Distribution rejected our credentials (401/403) — check token config");
  }
  throw new DistributionError(`Distribution responded HTTP ${res.status}${body ? `: ${body}` : ""}`, retryable, res.status);
}

export function distributionClient(opts: DistributionClientOptions): DistributionClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISTRIBUTION_TIMEOUT_MS;

  return {
    async send(req: MessageRequest): Promise<{ batchId: string }> {
      const requestBody: MessageRequest = { ...req, replyTo: req.replyTo ?? opts.replyTo };
      return callDistribution(opts, doFetch, timeoutMs, "/api/messages", { method: "POST", body: requestBody }, batchResponseSchema, "Distribution response missing batchId");
    },
    async getSettings(): Promise<{ paused: boolean }> {
      return callDistribution(opts, doFetch, timeoutMs, "/api/settings", { method: "GET" }, settingsResponseSchema, "Distribution response missing paused");
    },
    async setPaused(paused: boolean): Promise<{ paused: boolean; changed: boolean }> {
      const path = paused ? "/api/settings/pause" : "/api/settings/resume";
      return callDistribution(opts, doFetch, timeoutMs, path, { method: "POST" }, pauseResponseSchema, "Distribution response missing paused/changed");
    },
    async uploadBounce(raw: string): Promise<{ id: string }> {
      return callDistribution(opts, doFetch, timeoutMs, "/api/bounces/inbox", { method: "POST", body: { raw } }, uploadBounceResponseSchema, "Distribution response missing id");
    },
    async bounceStats(since: string): Promise<{ unmatched: number; ignored: number }> {
      const path = `/api/bounces/stats?since=${encodeURIComponent(since)}`;
      return callDistribution(opts, doFetch, timeoutMs, path, { method: "GET" }, bounceStatsResponseSchema, "Distribution response missing unmatched/ignored");
    },
  };
}
