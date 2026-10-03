import express from "express";
import { sql } from "drizzle-orm";
import type { JWTVerifyGetKey } from "jose";
import type { Db } from "@gcpe/db-kit";
import { requireBearer } from "@gcpe/auth";
import { MAX_EVENT_BYTES, type SubscriberConfig } from "@gcpe/events";
import { apiRoutes } from "./http/routes";

export function createApp(deps: {
  db: Db;
  subscribers: SubscriberConfig[];
  auth: { issuer: string; audience: string; keys: JWTVerifyGetKey };
}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health/live", (_req, res) => void res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await deps.db.execute(sql`SELECT 1`);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api", express.json({ limit: MAX_EVENT_BYTES }), requireBearer(deps.auth), apiRoutes(deps.db, deps.subscribers));
  return app;
}
