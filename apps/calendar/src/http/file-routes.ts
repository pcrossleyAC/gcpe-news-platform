import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ATTACHMENT_MAX_BYTES, safeString } from "@gcpe/calendar-contract";
import { ActivityNotFoundError } from "../activities/errors";
import { addFile, precheckFileWrite, removeFile, StoredFileMissingError } from "../activities/files";
import { idOf } from "./activity-routes";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

type Params = { id: string; fileId: string };
type Handler = (req: Request<Params>, res: Response) => Promise<void>;
const nameQuery = z.object({ name: safeString().min(1).max(1000) }).strict();

export function fileIdOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.fileId)) throw new ActivityNotFoundError();
  return Number(req.params.fileId);
}

function fail(e: unknown, req: Request<Params>, res: Response, next: NextFunction): void {
  if (e instanceof StoredFileMissingError) {
    console.error("[calendar] a stored file is missing", `${req.method} ${req.baseUrl}${req.path}`);
    return void res.status(404).json({ error: "not found" });
  }
  if (!sendActivityError(e, res, req)) next(e);
}
/** The final handler of a route. */
const run = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => void h(req, res).catch((e: unknown) => fail(e, req, res, next));
/** A check that lets the request on when it passes. */
const guard = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => void h(req, res).then(() => next(), (e: unknown) => fail(e, req, res, next));

/**
 * Attachments (spec addendum §8.4). Mounted after requireCalendarActor and before the JSON parser,
 * so an upload's raw bytes reach express.raw untouched, and only after every check a save would
 * make has passed: a caller who can't attach the file is refused without it being buffered.
 */
export function fileRoutes(deps: ApiDeps): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES });
  const needStore = (_req: Request, res: Response, next: NextFunction) =>
    deps.store ? next() : void res.status(503).json({ error: "File storage isn't configured." });

  r.post(
    "/activities/:id/files",
    needStore,
    guard(async (req, res) => {
      res.locals.fileName = nameQuery.parse(req.query).name;
      await precheckFileWrite(deps, req.calendar!, idOf(req));
    }),
    raw,
    run(async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.status(201).json(await addFile(deps, deps.store!, req.calendar!, idOf(req), res.locals.fileName as string, bytes));
    }),
  );
  r.delete("/activities/:id/files/:fileId", needStore, run(async (req, res) => {
    res.json(await removeFile(deps, deps.store!, req.calendar!, idOf(req), fileIdOf(req)));
  }));
  return r;
}
