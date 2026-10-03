import express from "express";
import { sql } from "drizzle-orm";
import type { JWTVerifyGetKey } from "jose";
import type { Db } from "@gcpe/db-kit";
import { requireBearer } from "@gcpe/auth";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { MAX_EVENT_BYTES, type SubscriberConfig } from "@gcpe/events";
import { apiRoutes } from "./http/routes";

export function createApp(deps: {
  db: Db;
  subscribers: SubscriberConfig[];
  auth: { issuer: string; audience: string; keys: JWTVerifyGetKey };
}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use("/api", requireBearer(deps.auth), express.json({ limit: MAX_EVENT_BYTES }), apiRoutes(deps.db, deps.subscribers));
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[core]" }));
  return app;
}
