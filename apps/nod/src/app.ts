import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import { createEventReceiver } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { createAsItHappensHandler, type AsItHappensOptions } from "./as-it-happens";
import { apiRoutes } from "./http/routes";
import { subscribeApiRoutes } from "./http/subscribe-routes";
import { listsHandler } from "./lists";
import type { JourneyDeps } from "./subscribe/journeys";

export interface AppDeps {
  db: Db;
  auth: BearerOptions;
  loginRouter?: Router | null;
  eventSecrets: Record<string, string>;
  handlerOptions: AsItHappensOptions;
  /** Phase 4a: the legacy public Subscribe API, mounted at /api/Subscribe when set. */
  subscribe?: JourneyDeps;
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
      handlers: (ev) => (ev.source === "nrms" && ev.type === "release.published" ? handler : listsHandler(ev)),
    }),
  );

  if (deps.loginRouter) app.use(deps.loginRouter);
  if (deps.subscribe) app.use("/api/Subscribe", requireBearer(deps.auth), express.json({ limit: "100kb" }), subscribeApiRoutes(deps.subscribe));
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use("/api", requireBearer(deps.auth), express.json({ limit: "100kb" }), apiRoutes(deps.db));
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[nod]" }));
  return app;
}
