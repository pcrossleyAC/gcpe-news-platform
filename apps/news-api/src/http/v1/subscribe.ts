import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";

export interface SubscribeProxyOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  rateLimitPerMinute: number;
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

export function subscribeRoutes(opts: SubscribeProxyOptions | undefined): Router {
  const r = Router();
  if (!opts) {
    r.all("/Subscribe/{*rest}", (_req, res) => void res.status(503).json({ error: "subscriptions unavailable" }));
    return r;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  r.use("/Subscribe", rateLimit({ windowMs: 60_000, limit: opts.rateLimitPerMinute, standardHeaders: "draft-8", legacyHeaders: false }));

  for (const [method, path] of ROUTES) {
    r[method](path, express.json({ limit: "100kb" }), async (req, res) => {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (k === "api-version") continue;
        for (const value of Array.isArray(v) ? v : [v]) if (typeof value === "string") query.append(k, value);
      }
      const qs = query.toString();
      const target = `${opts.baseUrl.replace(/\/$/, "")}/api${req.path}${qs ? `?${qs}` : ""}`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (opts.getToken) headers.authorization = `Bearer ${await opts.getToken()}`;
      if (method === "post") headers["content-type"] = "application/json";
      try {
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
