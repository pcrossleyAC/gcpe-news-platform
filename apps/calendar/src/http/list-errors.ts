import type { NextFunction, Request, Response } from "express";
import { sendActivityError } from "./errors";

/** The list routes' errors; anything else falls through to the activity error mapping. */
export function sendListError(e: unknown, res: Response, req: Request): boolean {
  return sendActivityError(e, res, req);
}

export const runList = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (!sendListError(e, res, req)) next(e);
  });
