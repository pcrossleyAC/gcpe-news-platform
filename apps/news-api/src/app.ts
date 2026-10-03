import express from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { createEventReceiver } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler, type ReadinessCheck } from "@gcpe/http-kit";
import { problemNotFound, requireApiVersion } from "./http/errors";
import { categoryRoutes } from "./http/v1/categories";
import { postRoutes } from "./http/v1/posts";
import { siteRoutes } from "./http/v1/site";
import { subscribeRoutes, type SubscribeProxyOptions } from "./http/v1/subscribe";
import { createSourceRestrictedHandlers } from "./projections";

export type { SubscribeProxyOptions };

export interface AppDeps {
  db: Db;
  timeZone: string;
  eventSecrets: Record<string, string>;
  subscribe?: SubscribeProxyOptions;
  hubRouter?: express.Router;
  /** Extra /health/ready checks on top of the DB ping (e.g. the LISTEN connection being up). */
  readinessChecks?: ReadinessCheck[];
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: the OpenShift router

  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`), ...(deps.readinessChecks ?? [])]));

  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: createSourceRestrictedHandlers() }));
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
  // No route matched (after the api-version check, so an unversioned unknown route still
  // gets the ApiVersionUnspecified 400 the live API gives): same 404 problem JSON as the
  // index-key lookups, never Express's HTML "Cannot GET".
  api.use((_req, res) => problemNotFound(res));
  app.use("/api", api);
  app.use((_req, res) => void res.status(404).json({ error: "not found" }));

  app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));

  return app;
}
