import express from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { createEventReceiver } from "@gcpe/events";
import { requireApiVersion } from "./http/errors";
import { categoryRoutes } from "./http/v1/categories";
import { siteRoutes } from "./http/v1/site";
import { createProjectionHandlers } from "./projections";

export interface SubscribeProxyOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;
  rateLimitPerMinute: number;
}

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
  api.use(requireApiVersion());
  api.use((_req, res, next) => {
    res.set("Cache-Control", "no-cache");
    next();
  });
  api.use(categoryRoutes(deps.db, deps.timeZone));
  api.use(siteRoutes(deps.db, deps.timeZone));
  app.use("/api", api);
  return app;
}
