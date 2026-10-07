import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import type { ItemSending } from "../as-it-happens";
import { DistributionError, type DistributionClient } from "../distribution-client";
import type { MediaHubClient } from "../media-hub/client";
import { getSettings, setDistributionPaused, setPaused } from "../settings";
import { countSubscribers } from "../subscribers";
import { emailAddressSchema } from "../subscribe/info";
import { safeErrorLabel } from "../subscribe/journeys";
import { staffListRoutes } from "./staff-list-routes";
import { staffMediaRoutes } from "./staff-media-routes";
import { listKeySchema, staffSubscriberRoutes } from "./staff-subscriber-routes";

/** The add-subscriber schemas live with the add route (staff-subscriber-routes.ts); re-exported
 * for callers that import them from here. */
export { addSubscriberSchema, listKeySchema } from "./staff-subscriber-routes";

/** The count route's own schema -- unlike {@link listKeySchema} (addSubscriberSchema's own
 * use), this also accepts a `media-distribution-lists:<key>` key, since NRMS's
 * media contact count (`WorkflowDeps.countMediaContacts`) calls this same route. */
export const countListKeySchema = z.union([listKeySchema, z.string().regex(/^media-distribution-lists:.+$/i, "must be '<kind>:<key>'")]);

/** Re-exported for callers that import it from here (the add-from-hub route in
 * staff-media-routes.ts validates the chosen Media Hub email's address against this same schema
 * right before it reaches `addMediaMember`, since the contract itself -- media-hub/contract.ts --
 * deliberately doesn't require `.email()`). The schema itself now lives in subscribe/info.ts so media-hub/sync.ts
 * can share it too without an import cycle through this file. */
export { emailAddressSchema };

/** Moved to staff-media-routes.ts with the routes that use them; re-exported for callers that
 * import them from here. */
export { addMediaMemberSchema, resolveMediaMemberSchema, MEDIA_HUB_SEARCH_PAGE_SIZE } from "./staff-media-routes";

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
  // A DistributionClient call (the distribution/* routes below, calling Distribution over
  // HTTP) failed -- never the raw error (it can carry Distribution's response body) to the
  // caller, just that Distribution itself is unavailable right now.
  if (e instanceof DistributionError) return void (console.error("[nod] Distribution call failed", safeErrorLabel(e)), res.status(502).json({ error: "distribution unavailable" })), true;
  return false;
}

/** What the settings and distribution/* routes need beyond `db` -- a Distribution client
 * (able to send mail, and, for the distribution/* routes, read/set Distribution's pause
 * switch) and the resolved `NOD_OPS_EMAIL`/tenant time zone for the ops email both setPaused
 * and setDistributionPaused send. */
export interface SettingsRouteDeps {
  distribution: Pick<DistributionClient, "send" | "getSettings" | "setPaused">;
  opsEmail: string | null;
  timeZone: string;
}

export function apiRoutes(
  db: Db,
  items: Pick<ItemSending, "recordEmergencyItem">,
  settings: SettingsRouteDeps,
  mediaHub: MediaHubClient | null = null,
): Router {
  const r = Router();
  const run = <P>(h: Handler<P>): ReturnType<typeof safe<P>> =>
    safe<P>(async (req, res) => {
      try {
        await h(req, res);
      } catch (e) {
        if (!handleError(e, res)) throw e;
      }
    });

  r.get(
    "/subscribers/count",
    // Fix round 1 (review finding): "NoD.SubscriberCount" is a dedicated, read-only service
    // role for NRMS's own calls — minted with far less than the full NRMS.Editor write
    // credential (see apps/nrms/src/start.ts). NoD.Admin and NRMS.Editor can still call this
    // directly (NoD.Admin for ops, NRMS.Editor for a staff editor testing it by hand).
    requireAnyRole("NoD.Admin", "NRMS.Editor", "NoD.SubscriberCount"),
    run(async (req, res) => {
      const raw = typeof req.query.lists === "string" ? req.query.lists : "";
      const lists = z.array(countListKeySchema).parse(raw ? raw.split(",") : []);
      res.json({ count: await countSubscribers(db, lists) });
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

  // Distribution-wide pause, staff-controlled through NoD's own admin -- these never call
  // Distribution's settings routes directly from staff-web; NoD's own service token does, on
  // the caller's behalf, and the actor/audit trail stay on NoD's side (settings.ts's
  // setDistributionPaused).
  r.get(
    "/distribution/settings",
    requireRole("NoD.Admin"),
    run(async (_req, res) => {
      res.json(await settings.distribution.getSettings());
    }),
  );

  r.post(
    "/distribution/pause",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const result = await setDistributionPaused({ db, ...settings }, true, actorOf(req).name);
      res.json(result);
    }),
  );

  r.post(
    "/distribution/resume",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const result = await setDistributionPaused({ db, ...settings }, false, actorOf(req).name);
      res.json(result);
    }),
  );

  r.use(staffListRoutes(db));
  r.use(staffMediaRoutes(db, mediaHub));
  r.use(staffSubscriberRoutes(db));

  return r;
}

const bouncesInboxUploadSchema = z.object({ raw: z.string() });

/**
 * `POST /api/bounces/inbox` (`NoD.Admin`): proxies one raw bounce report to Distribution's own
 * fake-inbox upload (Global Constraints "Roles"), for staff manually uploading a test-site
 * bounce `.eml` through NoD rather than hitting Distribution directly. Distribution's own 1 MB
 * limit (Global Constraints "Bounce source") is enforced there, not re-validated here; a raw
 * message near that size is well over the shared `/api` mount's 100kb `express.json` limit
 * (app.ts), which is why this is mounted as its own route with a larger body limit instead of
 * living in {@link apiRoutes} alongside everything else NoD.Admin can do.
 *
 * Distribution 404s this when it isn't running in fake mode (nothing to upload into); that's
 * the one DistributionError this maps to its own 404 instead of the generic 502 every other
 * Distribution failure gets (handleError, above).
 */
export function bouncesInboxRoutes(distribution: Pick<DistributionClient, "uploadBounce">): Router {
  const r = Router();
  const run = <P>(h: Handler<P>): ReturnType<typeof safe<P>> =>
    safe<P>(async (req, res) => {
      try {
        await h(req, res);
      } catch (e) {
        if (e instanceof DistributionError && e.status === 404) {
          return void res.status(404).json({ error: "not available: the bounce source isn't the fake inbox" });
        }
        // Distribution's own 1 MB check (400) or its body-parser limit (413) -- never
        // duplicated here; both just mean the raw message itself was the problem.
        if (e instanceof DistributionError && (e.status === 400 || e.status === 413)) {
          return void res.status(400).json({ error: "invalid bounce message (too large or malformed)" });
        }
        if (!handleError(e, res)) throw e;
      }
    });

  r.post(
    "/",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const { raw } = bouncesInboxUploadSchema.parse(req.body);
      const result = await distribution.uploadBounce(raw);
      res.status(201).json(result);
    }),
  );

  return r;
}
