const DEFAULT_TIMEOUT_MS = 5000;

export interface NodClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface NodClient {
  countSubscribers(listKeys: string[]): Promise<number>;
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
