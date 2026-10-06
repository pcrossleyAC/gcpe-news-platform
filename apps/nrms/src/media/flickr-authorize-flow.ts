import { randomBytes } from "node:crypto";
import { oauthSignature, percentEncode } from "./flickr-client";

/**
 * The one-time OAuth 1.0a "out of band" sign-in dance (RFC 5849 §2, oob callback): get a request
 * token, send the operator to Flickr's authorize page, exchange the verifier it shows for an
 * access token. Used once, interactively, by `flickr:authorize` (apps/nrms/src/cli/flickr-authorize.ts)
 * to mint the long-lived access token/secret pasted into the environment at cutover — see C30 in
 * docs/parity/changes-from-legacy.md.
 *
 * Every request is signed the same way the ongoing REST calls are (flickr-client.ts's
 * `oauthSignature`): the request-token call with the consumer secret only (no token yet); the
 * access-token call with the consumer secret and the request token's own secret. Nothing here
 * ever puts a secret, token or signature in a thrown error — only the HTTP status (or, for a
 * `fetch` failure itself — a malformed `FLICKR_OAUTH_URL`, a timeout, a network error — a generic
 * description), same rule as flickr-client.ts. In particular, `fetch` throwing on an unparsable
 * URL quotes that URL (and with it this request's own signature, token and verifier) in its own
 * message, e.g. `Failed to parse URL from <url>?oauth_signature=...` — that's why the `fetch`
 * call itself is wrapped, not just the response handling below it.
 */

export interface AuthorizeFlowDeps {
  /** e.g. https://www.flickr.com/services/oauth (no trailing slash). */
  oauthUrl: string;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
  /** Reads one line from the operator, e.g. a readline `question`. */
  prompt: (q: string) => Promise<string>;
  /** Writes one line to the operator, e.g. `console.log`. */
  print: (line: string) => void;
  /** Test hooks. */
  nonce?: () => string;
  timestamp?: () => number;
}

export interface AuthorizeFlowResult {
  accessToken: string;
  accessSecret: string;
  username: string;
}

const TIMEOUT_MS = 10_000;

/** Oauth 1.0a's three endpoints answer `application/x-www-form-urlencoded` text, not JSON. */
async function signedOauthGet(
  doFetch: typeof fetch,
  step: string,
  url: string,
  extraParams: Record<string, string>,
  consumerKey: string,
  consumerSecret: string,
  token: string | undefined,
  tokenSecret: string,
  nonce: () => string,
  timestamp: () => number,
): Promise<Response> {
  const params: Record<string, string> = {
    ...extraParams,
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp()),
    oauth_version: "1.0",
    ...(token !== undefined ? { oauth_token: token } : {}),
  };
  const signature = oauthSignature("GET", url, params, consumerSecret, tokenSecret);
  const query = new URLSearchParams({ ...params, oauth_signature: signature }).toString();
  try {
    return await doFetch(`${url}?${query}`, { method: "GET", headers: { accept: "text/plain" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // Never rethrow `e` itself (or any text built from the URL above) -- see the module doc comment.
    const why = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timed out" : "couldn't reach Flickr's sign-in service";
    throw new Error(`Flickr authorize: ${step} ${why}`);
  }
}

/** Parses an oauth form-encoded response into the fields we need, or throws (HTTP status only —
 * never the body, which could otherwise echo a request's own signature or tokens back). */
async function oauthFields(res: Response, step: string, keys: readonly string[]): Promise<Map<string, string>> {
  if (!res.ok) throw new Error(`Flickr authorize: ${step} failed (HTTP ${res.status})`);
  const text = await res.text();
  const params = new URLSearchParams(text);
  const out = new Map<string, string>();
  for (const k of keys) {
    const v = params.get(k);
    if (!v) throw new Error(`Flickr authorize: ${step} response is missing ${k} (HTTP ${res.status})`);
    out.set(k, v);
  }
  return out;
}

export async function authorizeFlow(deps: AuthorizeFlowDeps): Promise<AuthorizeFlowResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const nonce = deps.nonce ?? (() => randomBytes(16).toString("hex"));
  const timestamp = deps.timestamp ?? (() => Math.floor(Date.now() / 1000));

  // 1. Request token (consumer secret only — no token exists yet).
  const requestTokenRes = await signedOauthGet(
    doFetch, "request_token", `${deps.oauthUrl}/request_token`, { oauth_callback: "oob" }, deps.apiKey, deps.apiSecret, undefined, "", nonce, timestamp,
  );
  const requestFields = await oauthFields(requestTokenRes, "request_token", ["oauth_token", "oauth_token_secret"]);
  const requestToken = requestFields.get("oauth_token")!;
  const requestTokenSecret = requestFields.get("oauth_token_secret")!;

  // 2. Send the operator to the authorize page; they come back with a verifier Flickr shows them.
  deps.print("Open this address, approve access, and copy the code it shows:");
  deps.print(`${deps.oauthUrl}/authorize?oauth_token=${percentEncode(requestToken)}&perms=write`);
  const verifier = (await deps.prompt("Verification code: ")).trim();

  // 3. Access token, signed with the request token's own secret.
  const accessTokenRes = await signedOauthGet(
    doFetch, "access_token", `${deps.oauthUrl}/access_token`, { oauth_verifier: verifier }, deps.apiKey, deps.apiSecret, requestToken, requestTokenSecret, nonce, timestamp,
  );
  const accessFields = await oauthFields(accessTokenRes, "access_token", ["oauth_token", "oauth_token_secret", "username"]);

  return {
    accessToken: accessFields.get("oauth_token")!,
    accessSecret: accessFields.get("oauth_token_secret")!,
    username: accessFields.get("username")!,
  };
}
