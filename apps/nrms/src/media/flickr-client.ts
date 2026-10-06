import { createHmac, randomBytes } from "node:crypto";

/**
 * Flickr API client: OAuth 1.0a (HMAC-SHA1) signed REST calls plus the public oEmbed endpoint.
 * No secrets, tokens or signatures ever appear in error messages: request URLs are never echoed.
 */

export interface FlickrConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  restUrl: string;
  oembedUrl: string;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  nonce?: () => string;
  timestamp?: () => number;
}

export type PhotoVisibility = "public" | "private";

export class FlickrError extends Error {
  constructor(readonly kind: "auth" | "not-found" | "unavailable" | "unexpected", message: string) {
    super(message);
    this.name = "FlickrError";
  }
}

export interface FlickrClient {
  getVisibility(photoId: string): Promise<PhotoVisibility>;
  makePublic(photoId: string): Promise<void>;
  confirmPublic(photoId: string): Promise<boolean>;
  staticImageUrl(pageUrl: string): Promise<string>;
}

const TIMEOUT_MS = 5_000;
const AUTH_CODES = new Set([96, 97, 98, 99, 100]);

export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** RFC 5849 §3.4 HMAC-SHA1 signature. `params` excludes `oauth_signature`. */
export function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret: string): string {
  const pairs = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(pairs.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  return createHmac("sha1", `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`).update(base).digest("base64");
}

const B58 = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export function decodeBase58(s: string): string {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  return n.toString();
}

function parseHttpUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u : null;
}

const PAGE_HOSTS = new Set(["flickr.com", "www.flickr.com", "m.flickr.com"]);

export function isFlickrUrl(url: string): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  const h = u.hostname.toLowerCase();
  return PAGE_HOSTS.has(h) || h === "flic.kr" || h === "staticflickr.com" || h.endsWith(".staticflickr.com");
}

/** Photo id from flickr.com/photos/<user>/<id>[/…], flic.kr/p/<base58>, or *.staticflickr.com/<server>/<id>_<secret>[_x].jpg. */
export function photoIdFromUrl(url: string): string | null {
  if (!isFlickrUrl(url)) return null;
  const u = new URL(url);
  const h = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);
  if (PAGE_HOSTS.has(h)) {
    return segs[0] === "photos" && segs[1] && segs[2] && /^\d+$/.test(segs[2]) ? segs[2] : null;
  }
  if (h === "flic.kr") {
    if (segs[0] !== "p" || !segs[1] || segs.length !== 2) return null;
    try {
      return decodeBase58(segs[1]);
    } catch {
      return null;
    }
  }
  const file = segs[segs.length - 1] ?? "";
  const m = /^(\d+)_[0-9a-f]+(?:_[a-z0-9]+)?\.(?:jpe?g|png|gif)$/i.exec(file);
  return m ? m[1]! : null;
}

interface FlickrJson {
  stat?: string;
  code?: number;
  message?: string;
  [k: string]: unknown;
}

export function flickrClient(cfg: FlickrConfig): FlickrClient {
  const doFetch = cfg.fetchImpl ?? fetch;
  const nonce = cfg.nonce ?? (() => randomBytes(16).toString("hex"));
  const timestamp = cfg.timestamp ?? (() => Math.floor(Date.now() / 1000));

  async function send(label: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      // The error's own message could quote the URL (and with it the signature); report only its type.
      const why = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timed out" : "network error";
      throw new FlickrError("unavailable", `Flickr ${label}: ${why}`);
    }
  }

  async function call(httpMethod: "GET" | "POST", method: string, args: Record<string, string>): Promise<FlickrJson> {
    const params: Record<string, string> = {
      ...args,
      method,
      format: "json",
      nojsoncallback: "1",
      api_key: cfg.apiKey,
      oauth_consumer_key: cfg.apiKey,
      oauth_nonce: nonce(),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(timestamp()),
      oauth_token: cfg.accessToken,
      oauth_version: "1.0",
    };
    params.oauth_signature = oauthSignature(httpMethod, cfg.restUrl, params, cfg.apiSecret, cfg.accessSecret);
    const body = new URLSearchParams(params).toString();
    const res =
      httpMethod === "GET"
        ? await send(method, `${cfg.restUrl}?${body}`, { method: "GET", headers: { accept: "application/json" } })
        : await send(method, cfg.restUrl, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
            body,
          });
    if (res.status >= 500) throw new FlickrError("unavailable", `Flickr ${method}: HTTP ${res.status}`);
    if (!res.ok) throw new FlickrError("unexpected", `Flickr ${method}: HTTP ${res.status}`);
    let json: FlickrJson;
    try {
      json = (await res.json()) as FlickrJson;
    } catch {
      throw new FlickrError("unexpected", `Flickr ${method}: response is not JSON`);
    }
    if (json?.stat === "ok") return json;
    const code = Number(json?.code);
    const detail = `Flickr ${method}: ${typeof json?.message === "string" ? json.message : "failed"} (code ${Number.isFinite(code) ? code : "?"})`;
    if (code === 1) throw new FlickrError("not-found", detail);
    if (AUTH_CODES.has(code)) throw new FlickrError("auth", detail);
    throw new FlickrError("unexpected", detail);
  }

  const isOne = (v: unknown) => v === 1 || v === "1";

  return {
    async getVisibility(photoId) {
      const json = await call("GET", "flickr.photos.getInfo", { photo_id: photoId });
      const vis = (json.photo as { visibility?: { ispublic?: unknown } } | undefined)?.visibility;
      if (!vis) throw new FlickrError("unexpected", "Flickr flickr.photos.getInfo: no visibility in response");
      return isOne(vis.ispublic) ? "public" : "private";
    },
    async makePublic(photoId) {
      await call("POST", "flickr.photos.setPerms", { photo_id: photoId, is_public: "1", is_friend: "0", is_family: "0" });
    },
    async confirmPublic(photoId) {
      const json = await call("GET", "flickr.photos.getPerms", { photo_id: photoId });
      const perms = json.perms as { ispublic?: unknown } | undefined;
      if (!perms) throw new FlickrError("unexpected", "Flickr flickr.photos.getPerms: no perms in response");
      return isOne(perms.ispublic);
    },
    async staticImageUrl(pageUrl) {
      const q = new URLSearchParams({ url: pageUrl, format: "json" }).toString();
      const res = await send("oEmbed", `${cfg.oembedUrl}?${q}`, { method: "GET", headers: { accept: "application/json" } });
      if (res.status >= 500) throw new FlickrError("unavailable", `Flickr oEmbed: HTTP ${res.status}`);
      // Flickr's oEmbed answers 404 for private, deleted and unknown photos.
      if (res.status === 404) throw new FlickrError("not-found", "Flickr oEmbed: photo not found or not public");
      if (!res.ok) throw new FlickrError("unexpected", `Flickr oEmbed: HTTP ${res.status}`);
      let json: { url?: unknown };
      try {
        json = (await res.json()) as { url?: unknown };
      } catch {
        throw new FlickrError("unexpected", "Flickr oEmbed: response is not JSON");
      }
      const u = typeof json?.url === "string" ? parseHttpUrl(json.url) : null;
      // https only — except a plain-http fake whose static files share the oEmbed endpoint's own origin.
      const sameOrigin = u !== null && u.origin === new URL(cfg.oembedUrl).origin;
      if (!u || (u.protocol !== "https:" && !sameOrigin)) throw new FlickrError("unexpected", "Flickr oEmbed: no https image url");
      return u.toString();
    },
  };
}
