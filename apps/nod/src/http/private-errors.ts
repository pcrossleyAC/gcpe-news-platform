import type { Request, Response } from "express";
import { safeErrorLabel } from "../subscribe/journeys";

/** Maps a router's own domain errors to a response; false for anything it doesn't know. */
export type ErrorMapper = (e: unknown, res: Response) => boolean;

/**
 * Wraps handlers so an error never reaches `next(err)`. These routers' queries bind email
 * addresses or search terms, a DrizzleQueryError's message carries its bound params, and the
 * shared jsonErrorHandler logs the whole error. Known errors go through `mapError`; anything
 * else is a bare 500, logged by its Postgres code or error name only.
 */
export function privateErrorsWith(mapError: ErrorMapper, label: string) {
  return function privateErrors<P>(handler: (req: Request<P>, res: Response) => Promise<void>) {
    return (req: Request<P>, res: Response): void => {
      handler(req, res).catch((e: unknown) => {
        if (mapError(e, res)) return;
        console.error(`[nod] ${label} failed`, safeErrorLabel(e));
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      });
    };
  };
}
