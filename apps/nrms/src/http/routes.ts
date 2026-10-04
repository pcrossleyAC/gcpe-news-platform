import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireAnyRole, requireRole } from "@gcpe/auth";
import * as releasesService from "../releases";
import { listCategories } from "../taxonomy";

const scheduleSchema = z.object({ publishAt: z.string().datetime({ offset: true }) });
type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const safe = <P>(h: Handler<P>) => (req: Request<P>, res: Response, next: NextFunction) => h(req, res).catch(next);

/**
 * Maps the service layer's typed errors (and the validation layer's ZodError) to a response.
 * Returns false for anything else so the caller can rethrow and let jsonErrorHandler turn it
 * into a generic, detail-free 500 (see http-kit/errors.ts).
 */
function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof releasesService.ReleaseExistsError) return void res.status(409).json({ error: "release exists" }), true;
  if (e instanceof releasesService.ReleaseAlreadyPublishedError) return void res.status(409).json({ error: "release already published" }), true;
  if (e instanceof releasesService.ReleaseNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof releasesService.ReleaseTooLargeError) return void res.status(413).json({ error: "release too large" }), true;
  // zod's offset-datetime check normally rejects a bad publishAt before scheduleRelease ever
  // sees it; this is defence-in-depth for anything that slips past that check as a Date that
  // still fails to parse.
  if (e instanceof RangeError) return void res.status(400).json({ error: "invalid request" }), true;
  return false;
}

export function apiRoutes(db: Db): Router {
  const r = Router();
  const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor");
  const run = <P>(h: Handler<P>): ReturnType<typeof safe<P>> =>
    safe<P>(async (req, res) => {
      try {
        await h(req, res);
      } catch (e) {
        if (!handleError(e, res)) throw e;
      }
    });

  r.get("/categories", read, run(async (_req, res) => void res.json(await listCategories(db))));

  r.post(
    "/releases",
    requireRole("NRMS.Editor"),
    run(async (req, res) => {
      const draft = releasesService.releaseDraftSchema.parse(req.body);
      await releasesService.createDraft(db, draft);
      res.status(201).json({ key: draft.key });
    }),
  );

  r.post(
    "/releases/:key/schedule",
    requireRole("NRMS.Editor"),
    run<{ key: string }>(async (req, res) => {
      const { publishAt } = scheduleSchema.parse(req.body);
      const at = new Date(publishAt);
      await releasesService.scheduleRelease(db, req.params.key, at);
      res.json({ key: req.params.key, status: "scheduled", publishAt: at.toISOString() });
    }),
  );

  r.get(
    "/releases/:key",
    // M1: unpublished drafts are embargoed — this must not be readable by any valid token,
    // only an editor.
    requireRole("NRMS.Editor"),
    run<{ key: string }>(async (req, res) => {
      const row = await releasesService.getRelease(db, req.params.key);
      if (!row) return void res.status(404).json({ error: "not found" });
      res.json({
        key: row.key,
        kind: row.kind,
        status: row.status,
        publishAt: row.publishAt,
        publishedAt: row.publishedAt,
        lastError: row.lastError,
        content: row.content,
      });
    }),
  );

  return r;
}
