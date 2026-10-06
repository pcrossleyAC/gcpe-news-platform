import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import { createEventReceiver } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { createItemSending } from "./as-it-happens";
import { apiRoutes } from "./http/routes";
import { subscribeApiRoutes } from "./http/subscribe-routes";
import { itemHandlers } from "./items";
import { listsHandler } from "./lists";
import type { RenderOptions } from "./render";
import type { JourneyDeps } from "./subscribe/journeys";

export interface AppDeps {
  db: Db;
  auth: BearerOptions;
  loginRouter?: Router | null;
  eventSecrets: Record<string, string>;
  /** Site URL (also used as `items`' own publicSiteUrl) and optional banner for every
   * As-It-Happens/emergency email this sends (Task 5). */
  render: RenderOptions;
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
  const { createItemSend, recordEmergencyItem } = createItemSending({ render: deps.render });
  const resolveItemHandler = itemHandlers({
    publicSiteUrl: deps.render.siteUrl,
    onPublished: (tx, r) => createItemSend(tx, r.key, "as_it_happens"),
  });
  app.use(
    createEventReceiver({
      db: deps.db,
      secrets: deps.eventSecrets,
      handlers: (ev) => resolveItemHandler(ev) ?? listsHandler(ev),
    }),
  );

  if (deps.loginRouter) app.use(deps.loginRouter);
  if (deps.subscribe) app.use("/api/Subscribe", requireBearer(deps.auth), express.json({ limit: "100kb" }), subscribeApiRoutes(deps.subscribe));
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use("/api", requireBearer(deps.auth), express.json({ limit: "100kb" }), apiRoutes(deps.db, { recordEmergencyItem }));
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[nod]" }));
  return app;
}
