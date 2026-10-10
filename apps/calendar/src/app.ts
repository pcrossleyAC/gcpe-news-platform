import express from "express";
import { sql } from "drizzle-orm";
import type { Db, TestClock } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import type { CalendarRules } from "@gcpe/calendar-contract";
import { createEventReceiver, type SubscriberConfig } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { requireCalendarActor } from "./actor";
import { apiRoutes } from "./http/routes";
import { projectionHandler } from "./projections";

export interface AppDeps {
  db: Db;
  auth: BearerOptions;
  eventSecrets: Record<string, string>;
  rules: CalendarRules;
  subscribers?: SubscriberConfig[];
  now?: TestClock;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: OpenShift router / SiteGround nginx
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));
  // Before any body parser: signatures cover the raw bytes.
  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: projectionHandler }));
  // Authenticate and resolve the Calendar actor before parsing, so a caller without Calendar
  // access can't make us buffer a body.
  app.use(
    "/api",
    requireBearer(deps.auth),
    requireCalendarActor(deps.db),
    express.json({ limit: "100kb" }),
    apiRoutes({ db: deps.db, rules: deps.rules, subscribers: deps.subscribers ?? [], now: deps.now }),
  );
  app.use(jsonErrorHandler({ logPrefix: "[calendar]" }));
  return app;
}
