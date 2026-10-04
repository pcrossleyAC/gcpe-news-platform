import express, { type RequestHandler, type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { ADMIN_ROLES, requireBearer, type BearerOptions, type LocalAuthConfig } from "@gcpe/auth";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { MAX_EVENT_BYTES, type SubscriberConfig } from "@gcpe/events";
import { apiRoutes } from "./http/routes";
import { BREAK_GLASS_ID, sessionRoutes } from "./http/session";
import { sessionUserFor } from "./services/users";

/**
 * A bearer token always decides for itself (requireBearer re-verifies it every request), but
 * the staff session cookie carries roles minted into it at login time and otherwise only gets
 * re-checked when Core itself renews it (GET /auth/session). Without this, a deactivated or
 * demoted Core.Admin keeps their old roles for the cookie's remaining life (up to 1h). So every
 * /api request made with the session cookie re-derives roles from the current DB state here.
 */
function requireCurrentSessionIdentity(db: Db, localConfigured: boolean): RequestHandler {
  return async (req, res, next) => {
    const auth = req.auth;
    if (!auth || auth.claims.via !== "session") return next(); // bearer tokens: unaffected
    if (auth.subject === BREAK_GLASS_ID) {
      // Break-glass has no users row; it's only valid while LOCAL_ADMIN_* config exists.
      if (!localConfigured) return void res.status(401).json({ error: "not signed in" });
      auth.roles = [...ADMIN_ROLES];
      return next();
    }
    const current = await sessionUserFor(db, auth.subject);
    if (!current) return void res.status(401).json({ error: "not signed in" });
    auth.roles = current.roles;
    auth.claims = { ...auth.claims, name: current.name };
    next();
  };
}

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
  app.use(
    "/api",
    requireBearer(deps.auth),
    requireCurrentSessionIdentity(deps.db, deps.session?.local != null),
    express.json({ limit: MAX_EVENT_BYTES }),
    apiRoutes(deps.db, deps.subscribers),
  );
  // Body-parser failures (malformed JSON 400, oversized 413) and anything a route lets
  // escape stay JSON instead of finalhandler's default HTML.
  app.use(jsonErrorHandler({ logPrefix: "[core]" }));
  return app;
}
