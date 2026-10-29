import express from "express";
import { sql } from "drizzle-orm";
import type { Db, TestClock } from "@gcpe/db-kit";
import { requireBearer, requireRole, type BearerOptions } from "@gcpe/auth";
import type { CalendarRules } from "@gcpe/calendar-contract";
import { createEventReceiver, type SubscriberConfig } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import type { ObjectStore } from "@gcpe/storage";
import { requireCalendarActor } from "./actor";
import { fileRoutes } from "./http/file-routes";
import { apiRoutes, type ApiDeps } from "./http/routes";
import { successionRoutes } from "./http/succession-routes";
import { projectionHandler } from "./projections";

export interface AppDeps {
  /** Reverse proxies in front of the app (TRUST_PROXY_HOPS); defaults to 1. */
  trustProxyHops?: number;
  db: Db;
  auth: BearerOptions;
  eventSecrets: Record<string, string>;
  rules: CalendarRules;
  subscribers?: SubscriberConfig[];
  now?: TestClock;
  store?: ObjectStore | null;
  reports?: ApiDeps["reports"];
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxyHops ?? 1); // hops: 1 = OpenShift router / SiteGround nginx / local IIS; TRUST_PROXY_HOPS=2 behind a DMZ proxy
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));
  // Before any body parser: signatures cover the raw bytes.
  const subscribers = deps.subscribers ?? [];
  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: (event) => projectionHandler(event, { rules: deps.rules, subscribers }) }));
  // Authenticate and resolve the Calendar actor before parsing, so a caller without Calendar
  // access can't make us buffer a body.
  const api: ApiDeps = { db: deps.db, rules: deps.rules, subscribers, now: deps.now, store: deps.store ?? null, reports: deps.reports ?? null };
  // A Core administrator's preview: not a Calendar actor, so it sits ahead of the /api actor gate.
  app.use("/api/succession", requireBearer(deps.auth), requireRole("Core.Admin"), successionRoutes(api));
  app.use("/api", requireBearer(deps.auth), requireCalendarActor(deps.db), fileRoutes(api), express.json({ limit: "100kb" }), apiRoutes(api));
  app.use(jsonErrorHandler({ logPrefix: "[calendar]" }));
  return app;
}
