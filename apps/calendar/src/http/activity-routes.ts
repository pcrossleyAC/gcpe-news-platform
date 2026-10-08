import { Router, type NextFunction, type Request, type Response } from "express";
import { createActivitySchema, type WriteResponse } from "@gcpe/calendar-contract";
import { createActivity } from "../activities/create";
import { ActivityNotFoundError } from "../activities/errors";
import { readActivity, readChanges } from "../activities/view";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

type Params = { id: string };
/** Legacy lets an HQ Editor below Advanced create a confidential activity for another ministry, then hides it from them. */
const CREATED_UNSEEN = "Saved. You can't view confidential activities for this ministry.";
type Handler = (req: Request<Params>, res: Response) => Promise<void>;
const run = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (!sendActivityError(e, res)) next(e);
  });

export function idOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.id)) throw new ActivityNotFoundError();
  return Number(req.params.id);
}

/** The activity API (spec addendum §7). Every capability is checked in the service functions (C138–C141). */
export function activityRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.post("/activities", run(async (req, res) => {
    const out = await createActivity(deps, req.calendar!, createActivitySchema.parse(req.body));
    // The create has committed: a 404 here would invite a retry and a duplicate.
    const activity = await readActivity(deps, req.calendar!, out.id).catch((e: unknown) => {
      if (e instanceof ActivityNotFoundError) return null;
      throw e;
    });
    const warnings = activity ? out.warnings : [...out.warnings, CREATED_UNSEEN];
    const body: WriteResponse = { id: out.id, activity, warnings };
    res.status(201).json(body);
  }));
  r.get("/activities/:id", run(async (req, res) => void res.json(await readActivity(deps, req.calendar!, idOf(req)))));
  r.get("/activities/:id/changes", run(async (req, res) => void res.json(await readChanges(deps, req.calendar!, idOf(req)))));
  return r;
}
