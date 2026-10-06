import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import { createEventReceiver } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { createAsItHappensHandler, type AsItHappensOptions } from "./as-it-happens";
import { apiRoutes } from "./http/routes";

export interface AppDeps {
  db: Db;
  auth: BearerOptions;
  loginRouter?: Router | null;
  eventSecrets: Record<string, string>;
  handlerOptions: AsItHappensOptions;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: OpenShift router / SiteGround nginx
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));

  // Mounted before any body parser: signatures cover the raw bytes (see
  // packages/events/src/receiver.ts), so an upstream express.json()/raw() that already
  // consumed the body would make every event fail verification.
  const handler = createAsItHappensHandler(deps.handlerOptions);
  app.use(
    createEventReceiver({
      db: deps.db,
      secrets: deps.eventSecrets,
      handlers: (ev) => (ev.source === "nrms" && ev.type === "release.published" ? handler : undefined),
    }),
  );

  if (deps.loginRouter) app.use(deps.loginRouter);
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use("/api", requireBearer(deps.auth), express.json({ limit: "100kb" }), apiRoutes(deps.db));
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[nod]" }));
  return app;
}
