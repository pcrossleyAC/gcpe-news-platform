import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import type { ItemSending } from "../as-it-happens";
import { DistributionError, type DistributionClient } from "../distribution-client";
import { MediaHubError, type MediaHubClient } from "../media-hub/client";
import { getMediaSyncStatus, resolveMediaMember, runMediaSync } from "../media-hub/sync";
import { addMediaMember, listMediaLists, listMediaMembers, MediaListNotFoundError, OptedOutError, removeMediaMember } from "../media-members";
import { getSettings, setDistributionPaused, setPaused } from "../settings";
import { addSubscriber, countSubscribers, SubscriberExistsError } from "../subscribers";
import { emailAddressSchema } from "../subscribe/info";
import { safeErrorLabel } from "../subscribe/journeys";
import { staffSubscriberRoutes } from "./staff-subscriber-routes";

/** '*' = all news, or '<kind>:<key>' with kind in ministries|sectors|themes|tags (matches indexKeysFor's output shape). */
export const listKeySchema = z
  .string()
  .regex(/^(ministries|sectors|themes|tags):.+$/i, "must be '<kind>:<key>' with kind in ministries|sectors|themes|tags");

/** The count route's own schema -- unlike {@link listKeySchema} (addSubscriberSchema's own
 * use, left unchanged), this also accepts a `media-distribution-lists:<key>` key, since NRMS's
 * media contact count (`WorkflowDeps.countMediaContacts`) calls this same route. */
export const countListKeySchema = z.union([listKeySchema, z.string().regex(/^media-distribution-lists:.+$/i, "must be '<kind>:<key>'")]);

/** Re-exported for callers that import it from here (the add-from-hub branch below validates
 * the chosen Media Hub email's address against this same schema right before it reaches
 * `addMediaMember`, since the contract itself -- media-hub/contract.ts -- deliberately doesn't
 * require `.email()`). The schema itself now lives in subscribe/info.ts so media-hub/sync.ts
 * can share it too without an import cycle through this file. */
export { emailAddressSchema };

export const addSubscriberSchema = z.object({
  email: emailAddressSchema,
  lists: z.union([z.literal("all"), z.array(listKeySchema)]),
});

export const addMediaMemberSchema = z.union([
  z.object({ email: emailAddressSchema, confirmOptOut: z.boolean().optional() }),
  z.object({ mediaHubContactId: z.number().int(), emailRef: z.string().min(1), confirmOptOut: z.boolean().optional() }),
]);

export const resolveMediaMemberSchema = z.object({ emailRef: z.string().min(1).optional() });

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
  // A MediaHubError's message/kind is safe to log (never carries a response body or address --
  // see client.ts) but is never handed to the caller verbatim; the client just sees that Media
  // Hub itself is unavailable right now.
  if (e instanceof MediaHubError) return void (console.error("[nod] Media Hub call failed", e.kind, e.message), res.status(502).json({ error: "media hub unavailable" })), true;
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

/** Fixed page size NoD's own search proxy asks Media Hub for (brief: "proxies search
 * (pageSize 25)") -- staff never choose a page size directly, only a query and page number. */
const MEDIA_HUB_SEARCH_PAGE_SIZE = 25;

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
      const lists = z.array(countListKeySchema).parse(raw ? raw.split(",") : []);
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

  r.get(
    "/media-hub/contacts",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      if (!mediaHub) return void res.status(503).json({ error: "media hub not configured" });
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
      res.json(await mediaHub.search(q, page, MEDIA_HUB_SEARCH_PAGE_SIZE));
    }),
  );

  r.post(
    "/media-lists/:key/members",
    requireRole("NoD.Admin"),
    run<{ key: string }>(async (req, res) => {
      const parsed = addMediaMemberSchema.parse(req.body);

      if ("mediaHubContactId" in parsed) {
        if (!mediaHub) return void res.status(503).json({ error: "media hub not configured" });
        const contact = await mediaHub.get(parsed.mediaHubContactId);
        const email = contact?.deletedAt ? undefined : contact?.emails.find((e) => e.ref === parsed.emailRef);
        if (!contact || contact.deletedAt || !email) return void res.status(404).json({ error: "not found" });

        // The contract's own `address` field isn't required to be a valid email (contract.ts)
        // -- this is where that's actually checked, using the same schema and the same
        // response shape as a manual add's bad email (handleError's ZodError case), so a
        // caller sees one consistent "this address is bad" answer regardless of which path hit it.
        const address = emailAddressSchema.safeParse(email.address);
        if (!address.success) return void res.status(400).json({ error: "invalid request", issues: address.error.issues });

        const { subscriberId, created } = await addMediaMember(
          db,
          req.params.key,
          { email: address.data, source: "media-hub", mediaHubContactId: parsed.mediaHubContactId, mediaHubEmailRef: parsed.emailRef, confirmOptOut: parsed.confirmOptOut },
          actorOf(req).name,
        );
        return void res.status(created ? 201 : 200).json({ subscriberId, created });
      }

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

  r.get(
    "/media-hub/sync",
    requireRole("NoD.Admin"),
    run(async (_req, res) => {
      res.json(await getMediaSyncStatus(db));
    }),
  );

  r.post(
    "/media-hub/sync",
    requireRole("NoD.Admin"),
    run(async (_req, res) => {
      if (!mediaHub) return void res.status(503).json({ error: "media hub not configured" });
      const outcome = await runMediaSync(db, mediaHub);
      if (outcome === "busy") return void res.status(409).json({ error: "sync in progress" });
      res.json(outcome);
    }),
  );

  r.post(
    "/media-members/:subscriberId/resolve",
    requireRole("NoD.Admin"),
    run<{ subscriberId: string }>(async (req, res) => {
      const parsed = resolveMediaMemberSchema.parse(req.body ?? {});
      const outcome = await resolveMediaMember(db, mediaHub, req.params.subscriberId, parsed.emailRef, actorOf(req).name);
      if (outcome === "not-found" || outcome === "ref-not-found") return void res.status(404).json({ error: "not found" });
      if (outcome === "media-hub-unavailable") return void res.status(503).json({ error: "media hub not configured" });
      if (outcome === "invalid-email") return void res.status(400).json({ error: "invalid email" });
      if (outcome === "email-taken") return void res.status(409).json({ error: "email-taken" });
      if (outcome === "conflict") return void res.status(409).json({ error: "changed, retry" });
      res.status(200).json({ ok: true });
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
