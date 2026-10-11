import { Router } from "express";
import { feedQuerySchema } from "@gcpe/calendar-contract";
import { readFeed } from "../feed";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** The updates feed (spec addendum §9.1): any Calendar role, every entry inside visibleSql. */
export function feedRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/updates", runList(async (req, res) => void res.json(await readFeed(deps, req.calendar!, feedQuerySchema.parse(req.query)))));
  return r;
}
