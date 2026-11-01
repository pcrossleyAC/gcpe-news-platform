import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 5000;

export interface NodClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** What NoD's `/api/subscribers/release-audience` takes (apps/nod/src/audience.ts). */
export interface ReleaseAudienceQuery {
  listKeys: string[];
  /** NoD media list keys (`media-distribution-lists:<key>`). */
  mediaListKeys: string[];
  toSubscribers: boolean;
  postKind: string;
}

/** Who a first publish reaches, by NoD's own send rules. */
export interface ReleaseAudienceCounts {
  asItHappens: number;
  digest: number;
  mediaContacts: number;
}

/** What NoD's `/api/subscribers/correction-audience` takes (apps/nod/src/correction.ts). */
export interface CorrectionAudienceQuery {
  itemKey: string;
  listKeys: string[];
  /** NoD media list keys (`media-distribution-lists:<key>`); empty when no media copy can go. */
  mediaListKeys: string[];
}

/** Who already got a release, per "Also email it again?" tick, and how many are in both. */
export interface CorrectionAudienceCounts {
  subscribers: number;
  mediaContacts: number;
  both: number;
}

export interface NodClient {
  countSubscribers(listKeys: string[]): Promise<number>;
  releaseAudience(q: ReleaseAudienceQuery): Promise<ReleaseAudienceCounts>;
  correctionAudience(q: CorrectionAudienceQuery): Promise<CorrectionAudienceCounts>;
}

/**
 * NRMS's client for NoD's `/api/subscribers/count` (Task 9) — used by the workflow's
 * `WorkflowDeps.countSubscribers` to show an editor roughly how many subscribers a release
 * will notify when it goes live. Bounded to 5s so a slow/unreachable NoD never hangs a
 * schedule call; the caller treats a rejection as "unknown" (see releases/workflow.ts).
 */
export function nodClient(opts: NodClientOptions): NodClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");

  return {
    async countSubscribers(listKeys: string[]): Promise<number> {
      const token = await opts.getToken();
      const url = `${base}/api/subscribers/count?lists=${encodeURIComponent(listKeys.join(","))}`;
      const res = await doFetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`NoD count failed: HTTP ${res.status}`);
      const json = (await res.json()) as { count: number };
      return json.count;
    },
    // Suite review R6: the Publish dialogs' numbers. Same 5 s bound and token as the count.
    async releaseAudience(q: ReleaseAudienceQuery): Promise<ReleaseAudienceCounts> {
      const token = await opts.getToken();
      const params = new URLSearchParams({ lists: q.listKeys.join(","), media: q.mediaListKeys.join(","), subscribers: String(q.toSubscribers), kind: q.postKind });
      const res = await doFetch(`${base}/api/subscribers/release-audience?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`NoD release audience failed: HTTP ${res.status}`);
      return (await res.json()) as ReleaseAudienceCounts;
    },
    // Owner decision 2026-10-31: the "Also email it again?" numbers. Same 5 s bound and token.
    async correctionAudience(q: CorrectionAudienceQuery): Promise<CorrectionAudienceCounts> {
      const token = await opts.getToken();
      const params = new URLSearchParams({ key: q.itemKey, lists: q.listKeys.join(","), media: q.mediaListKeys.join(",") });
      const res = await doFetch(`${base}/api/subscribers/correction-audience?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`NoD correction audience failed: HTTP ${res.status}`);
      return (await res.json()) as CorrectionAudienceCounts;
    },
  };
}

const CORE_TIMEOUT_MS = 10_000;

export interface CoreClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface CoreClient {
  adminEmails(): Promise<string[]>;
}

/**
 * NRMS's client for Core's `GET /api/directory/admin-emails` (Project Blue Bridge, plan 3d
 * task 4) — a narrow read, authenticated with the dedicated `Core.AdminDirectory` service role
 * (see start.ts's `coreServiceTokenOptions`). A non-2xx rejects with the status only — never
 * the token, and never any address (there is nothing to leak on this error path, by
 * construction).
 */
export function coreClient(opts: CoreClientOptions): CoreClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");

  return {
    async adminEmails(): Promise<string[]> {
      const token = await opts.getToken();
      const res = await doFetch(`${base}/api/directory/admin-emails`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Core admin-emails failed: HTTP ${res.status}`);
      const json = (await res.json()) as { emails: string[] };
      return json.emails;
    },
  };
}

// Generous: the body carries a PDF and a text file (base64), and Distribution only queues it.
const DISTRIBUTION_TIMEOUT_MS = 30_000;

/** The subset of Distribution's `POST /api/messages` body NRMS sends (apps/distribution/src/messages.ts). */
export interface MessageRequestLike {
  priority: "system" | "media" | "immediate" | "digest";
  idempotencyKey?: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  recipients: { email: string; substitutions?: Record<string, string> }[];
  attachments?: { filename: string; contentType: "application/pdf" | "text/plain"; contentBase64: string }[];
}

export interface DistributionClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface DistributionClient {
  send(msg: MessageRequestLike): Promise<{ batchId: string }>;
}

/** NRMS's client for Distribution's `POST /api/messages` ("Email me a copy"). A non-2xx rejects with the status. */
export function distributionClient(opts: DistributionClientOptions): DistributionClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/messages`;

  return {
    async send(msg: MessageRequestLike): Promise<{ batchId: string }> {
      const token = await opts.getToken();
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(DISTRIBUTION_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Distribution send failed: HTTP ${res.status}`);
      return (await res.json()) as { batchId: string };
    },
  };
}

// Embedding the draft (about 1s at most) plus two short queries.
const NEWS_API_SIMILAR_TIMEOUT_MS = 10_000;

/** The body of the News API's `POST /api/v2/internal/similar` (addendum §7). Draft text: never logged. */
export interface SimilarRequestBody {
  text: string;
  terms: string;
  mode: "ai" | "text";
  excludeKey?: string;
}

/** One result item. A null `url`, an unparseable `publishDate`, or any other malformed field
 * fails this schema; parsed with `safeParse` per item below, which drops just that item rather
 * than the whole response. */
const similarResultSchema = z.object({
  key: z.string(),
  headline: z.string().nullable(),
  publishDate: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  leadMinistryKey: z.string().nullable(),
  url: z.string().min(1),
  match: z.enum(["ai", "text"]),
});

/** The News API is a trusted service, but its response still crosses a network boundary, so it
 * isn't trusted blindly (M2): a malformed item is dropped, and a structurally wrong response
 * (not even `{ mode, results: [] }`) throws, which `findSimilar` turns into `{ kind: "failed" }`
 * and a 502 — the same path as a network or HTTP failure. */
const similarFoundSchema = z.object({
  mode: z.enum(["ai", "text"]),
  results: z.array(z.unknown()).transform((rows) => rows.map((r) => similarResultSchema.safeParse(r)).filter((p) => p.success).map((p) => p.data)),
});
export type SimilarFound = z.infer<typeof similarFoundSchema>;

export interface NewsApiSimilarClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface NewsApiSimilarClient {
  similar(body: SimilarRequestBody): Promise<SimilarFound>;
}

/** NRMS's client for the News API's similar route. A non-2xx rejects with the status only. */
export function newsApiSimilarClient(opts: NewsApiSimilarClientOptions): NewsApiSimilarClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v2/internal/similar`;
  return {
    async similar(body) {
      const token = await opts.getToken();
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(NEWS_API_SIMILAR_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`News API similar failed: HTTP ${res.status}`);
      return similarFoundSchema.parse(await res.json());
    },
  };
}
