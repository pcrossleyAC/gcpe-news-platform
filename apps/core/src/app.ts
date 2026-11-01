import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions, type LocalAuthConfig, type SessionGate } from "@gcpe/auth";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { MAX_EVENT_BYTES, type SubscriberConfig } from "@gcpe/events";
import { apiRoutes } from "./http/routes";
import type { EntraClient } from "./entra/client";
import { sessionRoutes } from "./http/session";
import { sessionGate } from "./services/sessions";

export function createApp(deps: {
  /** Reverse proxies in front of the app (TRUST_PROXY_HOPS); defaults to 1. */
  trustProxyHops?: number;
  db: Db;
  subscribers: SubscriberConfig[];
  /** The tenant's IANA time zone (a cabinet change's BC schedule time). Defaults to America/Vancouver. */
  timeZone?: string;
  auth: BearerOptions;
  loginRouter?: Router | null;
  session?: {
    secret: string;
    secure: boolean;
    local: LocalAuthConfig | null;
    entra?: EntraClient | null;
    userPasswordsAllowed?: boolean;
    entraRatePerMinute?: number;
    ratePerMinute?: number;
    /** SESSION_MAX_HOURS, in seconds. Default 12 hours. */
    maxSessionSeconds?: number;
  };
  /** Core's session gate (start.ts hands the same one to the stack); built here when not given. */
  sessionGate?: SessionGate;
}): express.Express {
  // The cookie carries the roles minted at sign-in; every /api request made with it checks the
  // person and this sign-in as Core holds them now (services/sessions.ts), so a deactivated
  // user is refused, a signed-out session too, and a demoted one gets their current roles.
  const gate = deps.sessionGate ?? sessionGate(deps.db, { localConfigured: deps.session?.local != null, secret: deps.session?.secret ?? deps.auth.session?.secret ?? "" });
  const auth: BearerOptions = deps.auth.session
    ? { ...deps.auth, session: { secure: deps.session?.secure, maxSessionSeconds: deps.session?.maxSessionSeconds, ...deps.auth.session, gate } }
    : deps.auth;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxyHops ?? 1); // hops: 1 = OpenShift router / SiteGround nginx / local IIS; TRUST_PROXY_HOPS=2 behind a DMZ proxy
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));
  if (deps.loginRouter) app.use(deps.loginRouter);
  if (deps.session) app.use(sessionRoutes({ db: deps.db, ...deps.session, gate }));
  // Authenticate before parsing so anonymous callers cannot make us buffer and parse bodies.
  app.use(
    "/api",
    requireBearer(auth),
    express.json({ limit: MAX_EVENT_BYTES }),
    apiRoutes(deps.db, deps.subscribers, { timeZone: deps.timeZone }),
  );
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[core]" }));
  return app;
}
