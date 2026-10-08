import { Router } from "express";
import type { Db } from "@gcpe/db-kit";
import { lookupRoutes } from "./lookup-routes";

/** The Calendar's /api, mounted behind requireBearer and requireCalendarActor. */
export function apiRoutes(db: Db): Router {
  const r = Router();
  // What the staff app shows comes from here, never from the session's roles.
  r.get("/me", (req, res) => void res.json(req.calendar));
  r.use(lookupRoutes(db));
  return r;
}
