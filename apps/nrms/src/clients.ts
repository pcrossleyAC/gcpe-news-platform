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
