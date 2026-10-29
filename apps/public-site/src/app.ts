import express from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { createEventReceiver, type EventEnvelope, type EventHandler } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";

export interface AppDeps {
  /** Reverse proxies in front of the app (TRUST_PROXY_HOPS); defaults to 1. */
  trustProxyHops?: number;
  db: Db;
  eventSecrets: Record<string, string>;
  handler: EventHandler;
  /** Runs after an applied event's transaction has committed (I1): the event receiver's own
   * response never waits on this. start.ts uses it to kick a background `syncSite` run — see
   * `kickBackgroundSync` (sync.ts) — without the request path waiting on a drain. */
  onApplied?: (event: EventEnvelope) => void;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxyHops ?? 1); // hops: 1 = OpenShift router / SiteGround nginx / local IIS; TRUST_PROXY_HOPS=2 behind a DMZ proxy

  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));

  app.use(
    createEventReceiver({
      db: deps.db,
      secrets: deps.eventSecrets,
      // This app has no staff /api: its only inbound traffic is /events and /health/*, and
      // it only ever honours site.rebuild_requested from the News API.
      handlers: (event) => (event.source === "news-api" && event.type === "site.rebuild_requested" ? deps.handler : undefined),
      onApplied: deps.onApplied,
    }),
  );

  app.use((_req, res) => void res.status(404).json({ error: "not found" }));

  app.use(jsonErrorHandler({ logPrefix: "[public-site]" }));

  return app;
}
