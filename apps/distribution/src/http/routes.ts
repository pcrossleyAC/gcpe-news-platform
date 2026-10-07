import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireRole } from "@gcpe/auth";
import * as messagesService from "../messages";
import * as settingsService from "../settings";

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
      // M2: scoped to the caller's own appId — another app's batch id must 404, not leak that
      // batch's status.
      const status = await messagesService.batchStatus(db, req.params.id, appIdFrom(req));
      if (!status) return void res.status(404).json({ error: "not found" });
      res.json(status);
    }),
  );

  // Distribution-wide pause (spec §6/§8): staff control this through NoD's own admin routes,
  // never directly — NoD's Distribution service token is the only caller these are gated for.
  r.get(
    "/settings",
    requireRole("Distribution.Operate"),
    run(async (_req, res) => {
      res.json(await settingsService.getSettings(db));
    }),
  );

  r.post(
    "/settings/pause",
    requireRole("Distribution.Operate"),
    run(async (_req, res) => {
      res.json(await settingsService.setPaused(db, true));
    }),
  );

  r.post(
    "/settings/resume",
    requireRole("Distribution.Operate"),
    run(async (_req, res) => {
      res.json(await settingsService.setPaused(db, false));
    }),
  );

  return r;
}
