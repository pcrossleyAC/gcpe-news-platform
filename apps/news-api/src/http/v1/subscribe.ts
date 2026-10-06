import express, { Router } from "express";
import type { Request, Response } from "express";
import { isIP } from "node:net";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

export interface SubscribeProxyOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  rateLimitPerMinute: number;
  /**
   * ONE_CLICK_RATE_LIMIT_PER_MIN, default 6000: the one-click unsubscribe POST gets its own
   * rate bucket, separate from rateLimitPerMinute above. Mail providers fan these out from a
   * small pool of shared sending IPs, so the generic per-client limit (sized for browser
   * traffic) would 429 legitimate unsubscribes; this bucket is sized for that traffic instead.
   */
  oneClickRateLimitPerMinute?: number;
  /**
   * SUBSCRIBE_CLIENT_IP_HEADER: when set (e.g. "x-client-ip"), the rate-limit bucket is keyed
   * on this request header — the end user's IP as forwarded by gcpe-news-webapp — instead of
   * req.ip, which behind the webapp is the webapp's own IP for every subscriber. Only set it
   * when the header can be trusted (see README). Unset: req.ip.
   */
  clientIpHeader?: string;
  fetchImpl?: typeof fetch;
}

const ONE_CLICK_RATE_LIMIT_PER_MIN_DEFAULT = 6000;

// Allow-listed response content-types: this proxy sits on the public, unauthenticated,
// token-bearing one-click route, so an upstream response of e.g. text/html must never be
// served as HTML from the News API origin. Only these two media types (the ones NoD and the
// upstream subscribe API actually use) pass through with their original header, including
// any charset; anything else — or no content-type at all — is downgraded to text/plain so a
// browser can't be tricked into rendering it.
const PASSTHROUGH_MEDIA_TYPES = new Set(["application/json", "text/plain"]);

const ROUTES: [method: "get" | "post", path: string][] = [
  ["get", "/Subscribe/SubscriptionItems/:categoryKey"],
  ["post", "/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences"],
  ["get", "/Subscribe/ConfirmUpdateCreateSubscription/:tokenGuid"],
  ["post", "/Subscribe/UpdateNewsOnDemandEmailSubscriptionWithPreferences/:tokenGuid"],
  ["get", "/Subscribe/ManageNewsOnDemandEmailSubscription/:emailAddress"],
  ["get", "/Subscribe/CheckEmailActivationToken/:tokenGuid"],
  ["get", "/Subscribe/UnsubscribeSubscriber/:tokenGuid"],
];

// Builds the upstream path from the route's own literal segments plus each
// param re-encoded with encodeURIComponent — never from req.path — so a
// param value can't inject extra "/" segments or a ".."/"%2e%2e" dot-segment
// that would collapse a segment once NoD resolves the request path.
function buildUpstreamPath(routePath: string, params: Record<string, string | string[] | undefined>): string | undefined {
  const segments: string[] = [];
  for (const seg of routePath.split("/")) {
    if (!seg.startsWith(":")) {
      segments.push(seg);
      continue;
    }
    const value = params[seg.slice(1)];
    if (typeof value !== "string" || value === "." || value === "..") return undefined;
    segments.push(encodeURIComponent(value));
  }
  return segments.join("/");
}

export function subscribeRoutes(opts: SubscribeProxyOptions | undefined): Router {
  const r = Router();
  if (!opts) {
    r.all("/Subscribe/{*rest}", (_req, res) => void res.status(503).json({ error: "subscriptions unavailable" }));
    return r;
  }
  // Narrowed to a plain const: TS doesn't carry the `if (!opts) return` narrowing of a
  // parameter into the nested `forward` closure below, since a parameter could in principle
  // be reassigned before the closure runs.
  const subscribeOpts = opts;
  const doFetch = subscribeOpts.fetchImpl ?? fetch;
  const clientIpHeader = subscribeOpts.clientIpHeader;
  const keyGenerator = (req: Request) => {
    // A missing/malformed header falls back to req.ip; ipKeyGenerator groups IPv6
    // addresses by subnet so one host can't rotate through its /64 for fresh buckets.
    const forwarded = clientIpHeader ? req.get(clientIpHeader)?.split(",")[0]?.trim() : undefined;
    const ip = forwarded && isIP(forwarded) ? forwarded : (req.ip ?? "");
    return ipKeyGenerator(ip);
  };

  // Shared forwarding: token, 15s timeout, status and (allow-listed) content-type
  // passthrough, X-Content-Type-Options: nosniff, and the 502 log line. The log line never
  // includes the upstream URL: for the one-click route, the path segment IS the subscriber's
  // token.
  async function forward(req: Request, res: Response, upstreamPath: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    try {
      const headers = { ...init.headers };
      if (subscribeOpts.getToken) headers.authorization = `Bearer ${await subscribeOpts.getToken()}`;
      const upstream = await doFetch(`${subscribeOpts.baseUrl.replace(/\/$/, "")}/api${upstreamPath}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await upstream.text();
      res.status(upstream.status);
      res.set("X-Content-Type-Options", "nosniff");
      const type = upstream.headers.get("content-type") ?? "";
      const mediaType = type.split(";")[0]?.trim().toLowerCase();
      res.set("content-type", mediaType && PASSTHROUGH_MEDIA_TYPES.has(mediaType) ? type : "text/plain; charset=utf-8");
      res.send(text);
    } catch (e) {
      console.error("[news-api] subscribe proxy failed", e);
      res.status(502).json({ error: "subscriptions upstream unavailable" });
    }
  }

  r.use(
    "/Subscribe",
    rateLimit({
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator,
      // One-click POSTs get their own bucket below — mail providers send these from a small
      // pool of shared sending IPs, which this per-client limit (sized for browser traffic)
      // would otherwise throttle.
      skip: (req) => req.path.startsWith("/OneClickUnsubscribe/"),
    }),
  );
  r.use(
    "/Subscribe/OneClickUnsubscribe",
    rateLimit({
      windowMs: 60_000,
      limit: opts.oneClickRateLimitPerMinute ?? ONE_CLICK_RATE_LIMIT_PER_MIN_DEFAULT,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator,
    }),
  );

  // RFC 8058 one-click unsubscribe: mail clients POST this with an
  // application/x-www-form-urlencoded body (never JSON) and no api-version query — handled
  // separately from the generic loop below, which always forwards JSON.
  r.post("/Subscribe/OneClickUnsubscribe/:tokenGuid", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const upstreamPath = buildUpstreamPath("/Subscribe/OneClickUnsubscribe/:tokenGuid", req.params);
    if (upstreamPath === undefined) return void res.status(400).json({ error: "invalid parameter" });
    await forward(req, res, upstreamPath, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
  });

  for (const [method, path] of ROUTES) {
    r[method](path, express.json({ limit: "100kb" }), async (req, res) => {
      const upstreamPath = buildUpstreamPath(path, req.params);
      if (upstreamPath === undefined) {
        return void res.status(400).json({ error: "invalid parameter" });
      }
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (k === "api-version") continue;
        for (const value of Array.isArray(v) ? v : [v]) if (typeof value === "string") query.append(k, value);
      }
      const qs = query.toString();
      const headers: Record<string, string> = { accept: "application/json" };
      if (method === "post") headers["content-type"] = "application/json";
      await forward(req, res, `${upstreamPath}${qs ? `?${qs}` : ""}`, {
        method: method.toUpperCase(),
        headers,
        body: method === "post" ? JSON.stringify(req.body ?? null) : undefined,
      });
    });
  }
  return r;
}
