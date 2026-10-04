import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import { createReleaseSchema, scheduleSchema, statusText, versionOnlySchema, type ReleaseView } from "@gcpe/nrms-contract";
import { ReleaseNotFoundError, ReleaseRuleError, ReleaseStateError, ReleaseTooLargeError, VersionConflictError } from "../releases/errors";
import { createRelease, deleteRelease } from "../releases/service";
import { loadView } from "../releases/store";
import { approve, cancel, schedule, unpublish, type WorkflowDeps } from "../releases/workflow";
import { listCategories } from "../taxonomy";

export interface RouteDeps {
  db: Db;
  workflow: WorkflowDeps;
}

type Handler = (req: Request<{ id: string }>, res: Response) => Promise<void>;

/**
 * Maps the service layer's typed errors (and zod's) to a response. Returns false for anything
 * else so it reaches jsonErrorHandler as a generic, detail-free 500 (see http-kit/errors.ts).
 */
function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof ReleaseRuleError) return void res.status(422).json({ error: e.problems.join(" "), problems: e.problems }), true;
  if (e instanceof VersionConflictError || e instanceof ReleaseStateError) return void res.status(409).json({ error: e.message }), true;
  if (e instanceof ReleaseNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof ReleaseTooLargeError) return void res.status(413).json({ error: "release too large" }), true;
  return false;
}

const run = (h: Handler) => (req: Request<{ id: string }>, res: Response, next: NextFunction) =>
  h(req, res).catch((e) => {
    if (!handleError(e, res)) next(e);
  });

export function apiRoutes(deps: RouteDeps): Router {
  const { db } = deps;
  const r = Router();
  const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor");
  const edit = requireRole("NRMS.Editor");
  const withStatus = (v: ReleaseView) => ({ ...v, statusText: statusText(v, Date.now()) });
  const version = (req: Request) => versionOnlySchema.parse(req.body).version;

  r.get("/categories", read, run(async (_req, res) => void res.json(await listCategories(db))));

  r.post(
    "/releases",
    edit,
    run(async (req, res) => {
      const view = await createRelease(db, createReleaseSchema.parse(req.body), actorOf(req));
      res.status(201).json(withStatus(view));
    }),
  );

  r.get(
    "/releases/:id",
    read,
    run(async (req, res) => {
      const view = await loadView(db, req.params.id);
      if (!view || view.status === "deleted") return void res.status(404).json({ error: "not found" });
      res.json(withStatus(view));
    }),
  );

  r.post("/releases/:id/approve", edit, run(async (req, res) => void res.json(withStatus(await approve(db, req.params.id, version(req), actorOf(req), deps.workflow)))));
  r.post("/releases/:id/schedule", edit, run(async (req, res) => void res.json(withStatus(await schedule(db, req.params.id, scheduleSchema.parse(req.body), actorOf(req), deps.workflow)))));
  r.post("/releases/:id/cancel", edit, run(async (req, res) => void res.json(withStatus(await cancel(db, req.params.id, version(req), actorOf(req))))));
  r.post("/releases/:id/unpublish", edit, run(async (req, res) => void res.json(withStatus(await unpublish(db, req.params.id, version(req), actorOf(req))))));
  r.post("/releases/:id/delete", edit, run(async (req, res) => void res.json({ result: await deleteRelease(db, req.params.id, version(req), actorOf(req)) })));

  return r;
}
