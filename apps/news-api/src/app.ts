import express from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { createEventReceiver } from "@gcpe/events";
import { requireApiVersion } from "./http/errors";
import { categoryRoutes } from "./http/v1/categories";
import { postRoutes } from "./http/v1/posts";
import { siteRoutes } from "./http/v1/site";
import { subscribeRoutes, type SubscribeProxyOptions } from "./http/v1/subscribe";
import { createProjectionHandlers } from "./projections";

export type { SubscribeProxyOptions };

export interface AppDeps {
  db: Db;
  timeZone: string;
  eventSecrets: Record<string, string>;
  subscribe?: SubscribeProxyOptions;
  hubRouter?: express.Router;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: the OpenShift router

  app.get("/health/live", (_req, res) => void res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await deps.db.execute(sql`SELECT 1`);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: createProjectionHandlers() }));
  if (deps.hubRouter) app.use(deps.hubRouter);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set("Cache-Control", "no-cache");
    next();
  });
  api.use(requireApiVersion());
  api.use(subscribeRoutes(deps.subscribe));
  api.use(categoryRoutes(deps.db, deps.timeZone));
  api.use(siteRoutes(deps.db, deps.timeZone));
  api.use(postRoutes(deps.db, deps.timeZone));
  app.use("/api", api);

  // Keep DB/handler failures as JSON, never finalhandler's default HTML-with-stack.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[news-api] request failed", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
