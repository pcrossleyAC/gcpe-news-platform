import express, { Router } from "express";
import { isIP } from "node:net";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

export interface SubscribeProxyOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  rateLimitPerMinute: number;
  /**
   * SUBSCRIBE_CLIENT_IP_HEADER: when set (e.g. "x-client-ip"), the rate-limit bucket is keyed
   * on this request header — the end user's IP as forwarded by gcpe-news-webapp — instead of
   * req.ip, which behind the webapp is the webapp's own IP for every subscriber. Only set it
   * when the header can be trusted (see README). Unset: req.ip.
   */
  clientIpHeader?: string;
  fetchImpl?: typeof fetch;
}

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
  const doFetch = opts.fetchImpl ?? fetch;
  const clientIpHeader = opts.clientIpHeader;
  r.use(
    "/Subscribe",
    rateLimit({
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => {
        // A missing/malformed header falls back to req.ip; ipKeyGenerator groups IPv6
        // addresses by subnet so one host can't rotate through its /64 for fresh buckets.
        const forwarded = clientIpHeader ? req.get(clientIpHeader)?.split(",")[0]?.trim() : undefined;
        const ip = forwarded && isIP(forwarded) ? forwarded : (req.ip ?? "");
        return ipKeyGenerator(ip);
      },
    }),
  );

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
      const target = `${opts.baseUrl.replace(/\/$/, "")}/api${upstreamPath}${qs ? `?${qs}` : ""}`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (method === "post") headers["content-type"] = "application/json";
      try {
        if (opts.getToken) headers.authorization = `Bearer ${await opts.getToken()}`;
        const upstream = await doFetch(target, {
          method: method.toUpperCase(),
          headers,
          body: method === "post" ? JSON.stringify(req.body ?? null) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        const text = await upstream.text();
        res.status(upstream.status);
        const type = upstream.headers.get("content-type");
        if (type) res.set("content-type", type);
        res.send(text);
      } catch (e) {
        console.error("[news-api] subscribe proxy failed", e);
        res.status(502).json({ error: "subscriptions upstream unavailable" });
      }
    });
  }
  return r;
}
