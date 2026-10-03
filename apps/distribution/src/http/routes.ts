import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireRole } from "@gcpe/auth";
import * as messagesService from "../messages";

const uuidSchema = z.string().uuid();
type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const safe = <P>(h: Handler<P>) => (req: Request<P>, res: Response, next: NextFunction) => h(req, res).catch(next);

/**
 * Maps the validation layer's ZodError to a response. Returns false for anything else so the
 * caller can rethrow and let jsonErrorHandler turn it into a generic, detail-free 500.
 */
function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  return false;
}

/** `azp` (the Entra v2 client id, or a local token's own azp) identifies the calling app;
 * falls back to the token's subject for callers that don't set one. */
function appIdFrom(req: Request): string {
  const azp = req.auth?.claims.azp;
  return typeof azp === "string" && azp ? azp : req.auth!.subject;
}

export function apiRoutes(db: Db, internalDomains: string[]): Router {
  const r = Router();
  const run = <P>(h: Handler<P>): ReturnType<typeof safe<P>> =>
    safe<P>(async (req, res) => {
      try {
        await h(req, res);
      } catch (e) {
        if (!handleError(e, res)) throw e;
      }
    });

  r.post(
    "/messages",
    requireRole("Distribution.Send"),
    run(async (req, res) => {
      const parsed = messagesService.messageRequestSchema.parse(req.body);
      const appId = appIdFrom(req);
      const { batchId, created } = await messagesService.createBatch(db, appId, parsed, internalDomains);
      res.status(created ? 202 : 200).json({ batchId });
    }),
  );

  r.get(
    "/batches/:id",
    run<{ id: string }>(async (req, res) => {
      // Reject a non-uuid id before it ever reaches the database.
      if (!uuidSchema.safeParse(req.params.id).success) return void res.status(404).json({ error: "not found" });
      const status = await messagesService.batchStatus(db, req.params.id);
      if (!status) return void res.status(404).json({ error: "not found" });
      res.json(status);
    }),
  );

  return r;
}
