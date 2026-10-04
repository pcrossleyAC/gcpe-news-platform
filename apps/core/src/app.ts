import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions, type LocalAuthConfig } from "@gcpe/auth";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { MAX_EVENT_BYTES, type SubscriberConfig } from "@gcpe/events";
import { apiRoutes } from "./http/routes";
import { sessionRoutes } from "./http/session";

export function createApp(deps: {
  db: Db;
  subscribers: SubscriberConfig[];
  auth: BearerOptions;
  loginRouter?: Router | null;
  session?: { secret: string; secure: boolean; local: LocalAuthConfig | null };
}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: OpenShift router / SiteGround nginx
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));
  if (deps.loginRouter) app.use(deps.loginRouter);
  if (deps.session) app.use(sessionRoutes({ db: deps.db, ...deps.session }));
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use("/api", requireBearer(deps.auth), express.json({ limit: MAX_EVENT_BYTES }), apiRoutes(deps.db, deps.subscribers));
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[core]" }));
  return app;
}
