import { Router, type NextFunction, type Request, type Response } from "express";
import { createActivitySchema, type WriteResponse } from "@gcpe/calendar-contract";
import { createActivity } from "../activities/create";
import { ActivityNotFoundError } from "../activities/errors";
import { readActivity, readChanges } from "../activities/view";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

type Params = { id: string };
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
    const body: WriteResponse = { activity: await readActivity(deps, req.calendar!, out.id), warnings: out.warnings };
    res.status(201).json(body);
  }));
  r.get("/activities/:id", run(async (req, res) => void res.json(await readActivity(deps, req.calendar!, idOf(req)))));
  r.get("/activities/:id/changes", run(async (req, res) => void res.json(await readChanges(deps, req.calendar!, idOf(req)))));
  return r;
}
