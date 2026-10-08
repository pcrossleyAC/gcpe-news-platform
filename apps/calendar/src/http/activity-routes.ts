import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { createActivitySchema, updateActivitySchema, type ActivityView, type WriteResponse } from "@gcpe/calendar-contract";
import { createActivity } from "../activities/create";
import { ActivityNotFoundError } from "../activities/errors";
import { releaseLock, takeLock } from "../activities/locks";
import { updateActivity } from "../activities/update";
import { readActivity, readChanges } from "../activities/view";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

const lockSchema = z.object({ tabId: z.string().min(1).max(100), takeOver: z.boolean().optional() }).strict();
const releaseSchema = z.object({ tabId: z.string().min(1).max(100) }).strict();

type Params = { id: string };
/** Legacy lets an HQ Editor below Advanced create, or make, a confidential activity for another ministry, then hides it from them. */
const SAVED_UNSEEN = "Saved. You can't view confidential activities for this ministry.";
type Handler = (req: Request<Params>, res: Response) => Promise<void>;
const run = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (!sendActivityError(e, res)) next(e);
  });

export function idOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.id)) throw new ActivityNotFoundError();
  return Number(req.params.id);
}

/**
 * The response to a write that has committed. If the writer can no longer see the activity, it is a
 * success with no activity: a 404 here would invite a retry, and on a create a duplicate.
 */
async function writeResponse(deps: ApiDeps, req: Request<Params>, id: number, warnings: string[]): Promise<WriteResponse> {
  const activity: ActivityView | null = await readActivity(deps, req.calendar!, id).catch((e: unknown) => {
    if (e instanceof ActivityNotFoundError) return null;
    throw e;
  });
  return { id, activity, warnings: activity ? warnings : [...warnings, SAVED_UNSEEN] };
}

/** The activity API (spec addendum §7). Every capability is checked in the service functions (C138–C141). */
export function activityRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.post("/activities", run(async (req, res) => {
    const out = await createActivity(deps, req.calendar!, createActivitySchema.parse(req.body));
    res.status(201).json(await writeResponse(deps, req, out.id, out.warnings));
  }));
  r.get("/activities/:id", run(async (req, res) => void res.json(await readActivity(deps, req.calendar!, idOf(req)))));
  r.put("/activities/:id", run(async (req, res) => {
    const id = idOf(req);
    const out = await updateActivity(deps, req.calendar!, id, updateActivitySchema.parse(req.body));
    res.json(await writeResponse(deps, req, id, out.warnings));
  }));
  r.get("/activities/:id/changes", run(async (req, res) => void res.json(await readChanges(deps, req.calendar!, idOf(req)))));
  r.put("/activities/:id/lock", run(async (req, res) => {
    const body = lockSchema.parse(req.body);
    res.json(await takeLock(deps, req.calendar!, idOf(req), body.tabId, body.takeOver ?? false));
  }));
  // The editor calls this on save, cancel and tab close (fetch with keepalive, which can send the CSRF header).
  r.post("/activities/:id/lock/release", run(async (req, res) => {
    await releaseLock(deps, req.calendar!, idOf(req), releaseSchema.parse(req.body).tabId);
    res.status(204).end();
  }));
  return r;
}
