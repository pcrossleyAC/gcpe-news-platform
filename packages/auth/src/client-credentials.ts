export function createClientCredentialsProvider(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    const now = (opts.now ?? Date.now)();
    if (cached && cached.expiresAt - 60_000 > now) return cached.token;
    const res = await (opts.fetchImpl ?? fetch)(opts.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        scope: opts.scope,
      }),
    });
    if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return cached.token;
  };
}
