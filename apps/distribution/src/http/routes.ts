import { Router, type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireRole } from "@gcpe/auth";
import { bounceInbox, bounces } from "../db/schema";
import * as messagesService from "../messages";
import * as settingsService from "../settings";

const uuidSchema = z.string().uuid();
type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const safe = <P>(h: Handler<P>) => (req: Request<P>, res: Response, next: NextFunction) => h(req, res).catch(next);

// 4e: the fake bounce inbox's own body limit (Global Constraints "Bounce source") — enforced
// here rather than by shrinking the app-wide express.json limit (app.ts's 10mb covers every
// other route too), since a raw .eml is text and this is the one route that should cap it.
const BOUNCE_INBOX_MAX_BYTES = 1024 * 1024;
const bounceInboxUploadSchema = z.object({
  raw: z.string().refine((s) => Buffer.byteLength(s, "utf8") <= BOUNCE_INBOX_MAX_BYTES, { message: `raw exceeds ${BOUNCE_INBOX_MAX_BYTES} bytes` }),
});

// 4e: NoD's daily bounce summary's own query (bounce-summary.ts) -- `since` is validated as a
// parseable instant before it ever reaches the database.
const bounceStatsQuerySchema = z.object({
  since: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "since must be a valid date" }),
});

/**
 * Maps the validation layer's ZodError to a response. Returns false for anything else so the
 * caller can rethrow and let jsonErrorHandler turn it into a generic, detail-free 500.
 */
function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  return false;
}

/** `azp` (the Entra v2 client id, or a local token's own azp) identifies the calling app.
 * Falls back to `appid` -- an Entra v1 access token carries the client id there instead, never
 * in `azp` -- and only then to the token's subject (which for an Entra client-credentials
 * token is the service principal's object id, not anything the caller chose; subject is what's
 * left for a caller that sets neither). */
function appIdFrom(req: Request): string {
  const claims = req.auth?.claims ?? {};
  const azp = claims.azp;
  if (typeof azp === "string" && azp) return azp;
  const appid = claims.appid;
  if (typeof appid === "string" && appid) return appid;
  return req.auth!.subject;
}

export function apiRoutes(db: Db, internalDomains: string[], bounceSource: "fake" | "graph"): Router {
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

  // 4e: the fake bounce inbox's own upload route (Global Constraints "Roles": gated the same
  // as the settings routes above — NoD's own Distribution.Operate-scoped token is the only
  // caller this is meant for, never staff directly). Only meaningful in fake mode; in graph
  // mode there's no fake inbox to upload into, so this 404s rather than silently accepting and
  // discarding a post.
  r.post(
    "/bounces/inbox",
    requireRole("Distribution.Operate"),
    run(async (req, res) => {
      if (bounceSource !== "fake") return void res.status(404).json({ error: "not found" });
      const parsed = bounceInboxUploadSchema.parse(req.body);
      const [inserted] = await db.insert(bounceInbox).values({ raw: parsed.raw }).returning({ id: bounceInbox.id });
      res.status(201).json({ id: inserted!.id });
    }),
  );

  // Lets NoD's own admin route (Global Constraints "Roles") decide whether to offer its
  // fake-inbox proxy upload at all, without NoD having to know Distribution's env directly.
  r.get(
    "/bounces/source",
    requireRole("Distribution.Operate"),
    run(async (_req, res) => {
      res.json({ source: bounceSource });
    }),
  );

  // 4e: feeds NoD's daily bounce summary (bounce-summary.ts) the two counts it can't get from
  // its own database -- bounces that never matched a message NoD sent, and messages that
  // weren't bounces at all (Global Constraints "Summary email": "counts of unmatched and
  // ignored messages"). `processed_at` (not `received_at`) is what bounds the window, the same
  // instant run.ts stamps every row with when it fetched and classified it.
  r.get(
    "/bounces/stats",
    requireRole("Distribution.Operate"),
    run(async (req, res) => {
      const { since } = bounceStatsQuerySchema.parse(req.query);
      const { rows } = await db.execute<{ unmatched: number; ignored: number }>(sql`
        SELECT
          count(*) FILTER (WHERE kind = 'bounce' AND matched = false)::int AS unmatched,
          count(*) FILTER (WHERE kind = 'ignored')::int AS ignored
        FROM ${bounces}
        WHERE processed_at > ${new Date(since)}
      `);
      res.json({ unmatched: rows[0]?.unmatched ?? 0, ignored: rows[0]?.ignored ?? 0 });
    }),
  );

  return r;
}
