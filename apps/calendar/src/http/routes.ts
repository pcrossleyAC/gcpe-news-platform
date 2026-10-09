import { Router } from "express";
import type { Db, TestClock } from "@gcpe/db-kit";
import type { CalendarRules } from "@gcpe/calendar-contract";
import type { SubscriberConfig } from "@gcpe/events";
import { activityRoutes } from "./activity-routes";
import { configRoutes } from "./config-routes";
import { deadLetterRoutes } from "./dead-letter-routes";
import { listRoutes } from "./list-routes";
import { lookupRoutes } from "./lookup-routes";
import { transferRoutes } from "./transfer-routes";
import { userRoutes } from "./user-routes";

export interface ApiDeps {
  db: Db;
  rules: CalendarRules;
  subscribers: SubscriberConfig[];
  /** A test hook standing in for the database's now() (packages/db-kit/src/claim.ts). */
  now?: TestClock;
}

/** The Calendar's /api, mounted behind requireBearer and requireCalendarActor. */
export function apiRoutes(deps: ApiDeps): Router {
  const r = Router();
  // What the staff app shows comes from here, never from the session's roles.
  r.get("/me", (req, res) => void res.json(req.calendar));
  r.use(configRoutes(deps));
  r.use(listRoutes(deps));
  r.use(activityRoutes(deps));
  r.use(lookupRoutes(deps.db));
  r.use(userRoutes(deps));
  r.use(transferRoutes(deps));
  r.use(deadLetterRoutes(deps));
  return r;
}
