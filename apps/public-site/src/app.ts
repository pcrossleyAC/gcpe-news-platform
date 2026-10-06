import express from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { createEventReceiver, type EventHandler } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";

export interface AppDeps {
  db: Db;
  eventSecrets: Record<string, string>;
  handler: EventHandler;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: the OpenShift router

  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));

  app.use(
    createEventReceiver({
      db: deps.db,
      secrets: deps.eventSecrets,
      // This app has no staff /api: its only inbound traffic is /events and /health/*, and
      // it only ever honours site.rebuild_requested from the News API.
      handlers: (event) => (event.source === "news-api" && event.type === "site.rebuild_requested" ? deps.handler : undefined),
    }),
  );

  app.use((_req, res) => void res.status(404).json({ error: "not found" }));

  app.use(jsonErrorHandler({ logPrefix: "[public-site]" }));

  return app;
}
