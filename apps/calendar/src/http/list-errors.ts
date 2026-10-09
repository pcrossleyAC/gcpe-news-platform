import type { NextFunction, Request, Response } from "express";
import { EXPORT_RETRY_AFTER_SECONDS, ExportBusyError, ExportTooLargeError } from "../list/export";
import { SavedFilterLimitError, SavedFilterNotFoundError, SavedFilterOrderError } from "../list/saved-filters";
import { sendActivityError } from "./errors";

/** The list routes' errors; anything else falls through to the activity error mapping. */
export function sendListError(e: unknown, res: Response, req: Request): boolean {
  if (e instanceof SavedFilterNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof SavedFilterOrderError) return void res.status(409).json({ code: "stale", error: e.message }), true;
  if (e instanceof SavedFilterLimitError) return void res.status(422).json({ error: e.message }), true;
  if (e instanceof ExportTooLargeError) return void res.status(422).json({ error: e.message }), true;
  if (e instanceof ExportBusyError) return void res.status(503).set("Retry-After", String(EXPORT_RETRY_AFTER_SECONDS)).json({ error: e.message }), true;
  return sendActivityError(e, res, req);
}

export const runList = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (!sendListError(e, res, req)) next(e);
  });
