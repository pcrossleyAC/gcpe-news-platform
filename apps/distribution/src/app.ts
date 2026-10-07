import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { apiRoutes } from "./http/routes";

export function createApp(deps: {
  db: Db;
  auth: BearerOptions;
  internalDomains: string[];
  loginRouter?: Router | null;
  /** Which bounce source start.ts wired up (env.ts's BOUNCE_SOURCE) — routes.ts's
   * `/bounces/inbox` only exists in "fake" mode; `/bounces/source` reports it either way.
   * Defaults to "fake" so every existing caller of createApp (tests that don't care about
   * bounces) keeps working unchanged. */
  bounceSource?: "fake" | "graph";
}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: OpenShift router / SiteGround nginx
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));
  if (deps.loginRouter) app.use(deps.loginRouter);
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use("/api", requireBearer(deps.auth), express.json({ limit: "10mb" }), apiRoutes(deps.db, deps.internalDomains, deps.bounceSource ?? "fake"));
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[distribution]" }));
  return app;
}
