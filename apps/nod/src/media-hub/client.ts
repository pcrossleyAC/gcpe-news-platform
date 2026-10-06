import { changesPageSchema, contactPageSchema, contactSchema, type MediaHubChangesPage, type MediaHubContact, type MediaHubContactPage } from "./contract";

/**
 * Thrown by every {@link MediaHubClient} method except `get`'s not-found case (which returns
 * `null` instead -- 404 there is an ordinary, expected outcome, not a failure).
 *
 * `kind` is `"contract"` for a 2xx response that fails {@link contactSchema}/etc validation,
 * `"network"` for a connection failure or our own request timeout, and `"http"` for any other
 * non-2xx status. Never carries the response body: Media Hub's only payload is contact data,
 * which can include addresses, and those must never land in a log line via an uncaught error's
 * message (Global Constraints, "Logs").
 */
export class MediaHubError extends Error {
  constructor(
    readonly kind: "contract" | "network" | "http",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MediaHubError";
  }
}

export interface MediaHubClient {
  search(q: string, page: number, pageSize: number): Promise<MediaHubContactPage>;
  /** `null` when Media Hub 404s -- an unknown id is an ordinary outcome, not a failure. */
  get(id: number): Promise<MediaHubContact | null>;
  changes(since: string, cursor: string | null): Promise<MediaHubChangesPage>;
}

export const DEFAULT_MEDIA_HUB_TIMEOUT_MS = 15_000;

export interface MediaHubClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Bounds a single request *and* a single getToken() call, same split as NoD's own
   * Distribution client (distribution-client.ts). */
  timeoutMs?: number;
}

/** Races `getToken()` against a timer -- mirrors distribution-client.ts's own helper. */
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

export function mediaHubClient(opts: MediaHubClientOptions): MediaHubClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEDIA_HUB_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function authedGet(path: string, query: Record<string, string>): Promise<Response> {
    let token: string;
    try {
      token = await getTokenWithTimeout(opts.getToken, timeoutMs);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new MediaHubError("network", `failed to get a Media Hub token: ${message}`);
    }

    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    try {
      return await doFetch(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Connection failure or our own timeout firing: no response body exists to leak.
      const message = e instanceof Error ? e.message : String(e);
      throw new MediaHubError("network", `request to Media Hub failed: ${message}`);
    }
  }

  return {
    async search(q, page, pageSize) {
      const res = await authedGet("/api/service/contacts", { q, page: String(page), pageSize: String(pageSize) });
      if (!res.ok) throw new MediaHubError("http", `Media Hub responded HTTP ${res.status}`, res.status);
      const json: unknown = await res.json().catch(() => undefined);
      const parsed = contactPageSchema.safeParse(json);
      if (!parsed.success) throw new MediaHubError("contract", "Media Hub's contacts response failed contract validation");
      return parsed.data;
    },

    async get(id) {
      const res = await authedGet(`/api/service/contacts/${id}`, {});
      if (res.status === 404) return null;
      if (!res.ok) throw new MediaHubError("http", `Media Hub responded HTTP ${res.status}`, res.status);
      const json: unknown = await res.json().catch(() => undefined);
      const parsed = contactSchema.safeParse(json);
      if (!parsed.success) throw new MediaHubError("contract", "Media Hub's contact response failed contract validation");
      return parsed.data;
    },

    async changes(since, cursor) {
      const query: Record<string, string> = { since };
      if (cursor !== null) query.cursor = cursor;
      const res = await authedGet("/api/service/contacts/changes", query);
      if (!res.ok) throw new MediaHubError("http", `Media Hub responded HTTP ${res.status}`, res.status);
      const json: unknown = await res.json().catch(() => undefined);
      const parsed = changesPageSchema.safeParse(json);
      if (!parsed.success) throw new MediaHubError("contract", "Media Hub's changes response failed contract validation");
      return parsed.data;
    },
  };
}
