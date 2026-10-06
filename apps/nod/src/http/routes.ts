import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import type { ItemSending } from "../as-it-happens";
import type { DistributionClient } from "../distribution-client";
import { addMediaMember, listMediaLists, listMediaMembers, MediaListNotFoundError, OptedOutError, removeMediaMember } from "../media-members";
import { getSettings, setPaused } from "../settings";
import { addSubscriber, countSubscribers, SubscriberExistsError } from "../subscribers";

/** '*' = all news, or '<kind>:<key>' with kind in ministries|sectors|themes|tags (matches indexKeysFor's output shape). */
export const listKeySchema = z
  .string()
  .regex(/^(ministries|sectors|themes|tags):.+$/i, "must be '<kind>:<key>' with kind in ministries|sectors|themes|tags");

export const addSubscriberSchema = z.object({
  email: z.string().email(),
  lists: z.union([z.literal("all"), z.array(listKeySchema)]),
});

export const addMediaMemberSchema = z.object({
  email: z.string().email(),
  confirmOptOut: z.boolean().optional(),
});

export const emergencyItemSchema = z.object({
  guid: z.string().min(1),
  title: z.string().min(1).max(500),
  summary: z.string().optional(),
  url: z.string().url().refine((u) => u.startsWith("http://") || u.startsWith("https://"), "must be an http(s) URL"),
  publishedAt: z.string().datetime().optional(),
});

type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const safe = <P>(h: Handler<P>) => (req: Request<P>, res: Response, next: NextFunction) => h(req, res).catch(next);

/**
 * Maps the validation/domain layer's errors to a response. Returns false for anything else so
 * the caller can rethrow and let jsonErrorHandler turn it into a generic, detail-free 500.
 */
function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof SubscriberExistsError) return void res.status(409).json({ error: "subscriber exists" }), true;
  if (e instanceof MediaListNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof OptedOutError) return void res.status(409).json({ error: "opted-out", at: e.at.toISOString() }), true;
  return false;
}

/** Task 7: what the pause/resume routes need beyond `db` -- a Distribution client and the
 * resolved `NOD_OPS_EMAIL`/tenant time zone for setPaused's ops email. */
export interface SettingsRouteDeps {
  distribution: Pick<DistributionClient, "send">;
  opsEmail: string | null;
  timeZone: string;
}

export function apiRoutes(db: Db, items: Pick<ItemSending, "recordEmergencyItem">, settings: SettingsRouteDeps): Router {
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
    "/subscribers",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const parsed = addSubscriberSchema.parse(req.body);
      const { id } = await addSubscriber(db, parsed);
      res.status(201).json({ id });
    }),
  );

  r.get(
    "/subscribers/count",
    // Fix round 1 (review finding): "NoD.SubscriberCount" is a dedicated, read-only service
    // role for NRMS's own calls — minted with far less than the full NRMS.Editor write
    // credential (see apps/nrms/src/start.ts). NoD.Admin and NRMS.Editor can still call this
    // directly (NoD.Admin for ops, NRMS.Editor for a staff editor testing it by hand).
    requireAnyRole("NoD.Admin", "NRMS.Editor", "NoD.SubscriberCount"),
    run(async (req, res) => {
      const raw = typeof req.query.lists === "string" ? req.query.lists : "";
      const lists = z.array(listKeySchema).parse(raw ? raw.split(",") : []);
      res.json({ count: await countSubscribers(db, lists) });
    }),
  );

  r.get(
    "/media-lists",
    requireRole("NoD.Admin"),
    run(async (_req, res) => {
      res.json(await listMediaLists(db));
    }),
  );

  r.get(
    "/media-lists/:key/members",
    requireRole("NoD.Admin"),
    run<{ key: string }>(async (req, res) => {
      res.json(await listMediaMembers(db, req.params.key));
    }),
  );

  r.post(
    "/media-lists/:key/members",
    requireRole("NoD.Admin"),
    run<{ key: string }>(async (req, res) => {
      const parsed = addMediaMemberSchema.parse(req.body);
      const { subscriberId, created } = await addMediaMember(
        db,
        req.params.key,
        { email: parsed.email, source: "manual-media", confirmOptOut: parsed.confirmOptOut },
        actorOf(req).name,
      );
      res.status(created ? 201 : 200).json({ subscriberId, created });
    }),
  );

  r.delete(
    "/media-lists/:key/members/:subscriberId",
    requireRole("NoD.Admin"),
    run<{ key: string; subscriberId: string }>(async (req, res) => {
      await removeMediaMember(db, req.params.key, req.params.subscriberId, actorOf(req).name);
      res.status(204).end();
    }),
  );

  r.post(
    "/emergency-items",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const parsed = emergencyItemSchema.parse(req.body);
      const { key, created } = await items.recordEmergencyItem(db, { ...parsed, summary: parsed.summary ?? "" });
      res.status(created ? 201 : 200).json({ key });
    }),
  );

  r.get(
    "/settings",
    requireRole("NoD.Admin"),
    run(async (_req, res) => {
      res.json(await getSettings(db));
    }),
  );

  r.post(
    "/settings/pause",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const { changed } = await setPaused({ db, ...settings }, true, actorOf(req).name);
      res.json({ paused: true, changed });
    }),
  );

  r.post(
    "/settings/resume",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const { changed } = await setPaused({ db, ...settings }, false, actorOf(req).name);
      res.json({ paused: false, changed });
    }),
  );

  return r;
}
