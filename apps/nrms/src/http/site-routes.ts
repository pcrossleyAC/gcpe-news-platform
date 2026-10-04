import express, { Router, type NextFunction, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import type { SubscriberConfig } from "@gcpe/events";
import type { ObjectStore } from "@gcpe/storage";
import { siteLog, type SiteLogArea } from "../db/schema";
import {
  createNextCarousel,
  deleteNextCarousel,
  getCarousels,
  getPins,
  makeNextLive,
  pinImage,
  saveCarousel,
  savePin,
  setPinImage,
  setPinned,
  setSlideImage,
  slideImage,
  type PinSlot,
} from "../website/carousel";
import { deleteFile, listFiles, uploadFile, MAX_SITE_FILE_BYTES } from "../website/files";
import { featuredWhere } from "../website/features";
import { getLinks, saveLinks } from "../website/links";
import { getBlueBridge, getLiveFeed, saveLiveFeed, setBlueBridge, type LiveFeedDefaults } from "../website/settings";
import { run, UUID, type Params } from "./routes";

export interface SiteRouteDeps {
  db: Db;
  subscribers: SubscriberConfig[];
  timeZone: string;
  /** Live Feed URLs to show when none is configured (env `LIVE_WEBCAST_*_URL_DEFAULT`). */
  liveFeedDefaults: LiveFeedDefaults;
  /** Where general files go; unset → the file upload/delete routes answer 503. */
  store?: ObjectStore;
  /** Plan 3d task 4: the public site's base URL, named in Project Blue Bridge's notify subject. */
  siteUrl: string;
  /** Plan 3d task 4: Project Blue Bridge's post-commit notify. */
  notify: (subject: string, text: string) => Promise<void>;
}

/** Legacy ProjectBlueBridge.aspx:50 — shown on every GET so the staff app can display it next to the switch. */
export const BLUE_BRIDGE_WARNING = "Do not click OK unless you have approval from IGRS";

/** Slide/pin images, same 2 MiB cap as the brief (constraints.md §6.1). */
export const MAX_SITE_IMAGE_BYTES = 2 * 1024 * 1024;
const SLOT = /^(primary|secondary)$/;
const AREAS: readonly SiteLogArea[] = ["carousel", "pins", "live-feed", "blue-bridge", "links", "files", "features"];

const dateish = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be a valid date/time");
const httpOrEmpty = z
  .string()
  .trim()
  .max(255)
  .refine((s) => s === "" || /^https?:\/\/\S+$/i.test(s), "must be an absolute http:// or https:// URL, or empty");
const justify = z.enum(["left", "right"]);

const slideInputSchema = z.object({
  id: z.string().uuid().optional(),
  headline: z.string().max(255),
  summary: z.string().max(255),
  actionUrl: httpOrEmpty,
  facebookPostUrl: httpOrEmpty,
  justify,
});
const createNextSchema = z.object({ goLiveAt: dateish });
const saveCarouselSchema = z.object({
  version: z.number().int().positive(),
  goLiveAt: dateish.optional(),
  slides: z.array(slideInputSchema),
});
const savePinSchema = z.object({
  version: z.number().int().positive(),
  headline: z.string().max(255),
  summary: z.string().max(255),
  actionUrl: httpOrEmpty,
  facebookPostUrl: httpOrEmpty,
  justify,
});
const setPinnedSchema = z.object({ version: z.number().int().positive(), pinned: z.boolean() });
const deleteNextQuerySchema = z.object({ version: z.coerce.number().int().positive() });
const logQuerySchema = z.object({
  area: z.enum(AREAS as [SiteLogArea, ...SiteLogArea[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const liveFeedSchema = z.object({
  version: z.number().int().positive(),
  enabled: z.boolean(),
  manifestUrl: z.string().trim().max(255),
  m3uUrl: z.string().trim().max(255),
});

const blueBridgeSchema = z.object({
  version: z.number().int().positive(),
  on: z.boolean(),
  confirmation: z.string(),
  acknowledgeIgrs: z.boolean(),
});

const linkInputSchema = z.object({
  id: z.string().uuid().optional(),
  text: z.string().max(255),
  url: z.string().max(255),
});
const saveLinksSchema = z.object({
  version: z.number().int().positive(),
  links: z.array(linkInputSchema),
});

const filesQuerySchema = z.object({
  q: z.string().trim().max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
const uploadFileQuerySchema = z.object({
  name: z.string().min(1).max(1000),
  replace: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

const bytesOf = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
const notFound = (res: Response) => void res.status(404).json({ error: "not found" });

/** Validates the query string *before* any body is read, so a malformed request never gets buffered (as media-routes.ts does). */
const query =
  <T extends z.ZodTypeAny>(schema: T) =>
  (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return void res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    res.locals.query = parsed.data as z.infer<T>;
    next();
  };

/**
 * The home-page carousel, emergency pins and the site activity log (plan 3d task 2). Routes are
 * absolute under `/site/...` (not a nested `/site` mount) and this router is mounted at `/api`
 * alongside `mediaRoutes`, *before* the global `express.json()` — the same ordering as
 * media-routes.ts and for the same reason: the image upload routes below read raw bytes with
 * their own `express.raw`, which an upstream JSON body-parser must not reach first. (It isn't
 * mounted from inside `apiRoutes`/routes.ts: `run`/`UUID`/`Params` are imported *from*
 * routes.ts, so mounting this router there too would make the two modules import each other —
 * a cycle that breaks at load time, since routes.ts would need this module's export before its
 * own `run`/`UUID` are defined.)
 */
export function siteRoutes(deps: SiteRouteDeps): Router {
  const { db, subscribers, timeZone, liveFeedDefaults, siteUrl, notify } = deps;
  const r = Router();
  const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor", "Core.Admin");
  const edit = requireRole("NRMS.SiteEditor");
  const blueBridgeAdmin = requireRole("Core.Admin");
  const json = express.json({ limit: "64kb" });
  const rawImage = express.raw({ type: () => true, limit: MAX_SITE_IMAGE_BYTES });
  const rawFile = express.raw({ type: () => true, limit: MAX_SITE_FILE_BYTES });
  const needStore = (_req: Request, res: Response, next: NextFunction) =>
    deps.store ? next() : void res.status(503).json({ error: "File storage isn't configured." });

  r.param("id", (_req, res, next, value: string) => (UUID.test(value) ? next() : notFound(res)));
  r.param("slot", (_req, res, next, value: string) => (SLOT.test(value) ? next() : notFound(res)));

  r.get("/site/carousels", read, run(async (_req, res) => void res.json(await getCarousels(db))));

  r.post(
    "/site/carousels/next",
    edit,
    json,
    run(async (req, res) => {
      const input = createNextSchema.parse(req.body);
      res.status(201).json(await createNextCarousel(db, input, actorOf(req), subscribers, timeZone));
    }),
  );

  r.put(
    "/site/carousels/:id",
    edit,
    json,
    run(async (req: Request<Params>, res) => {
      const input = saveCarouselSchema.parse(req.body);
      res.json(await saveCarousel(db, req.params.id, input, actorOf(req), subscribers));
    }),
  );

  r.post(
    "/site/carousels/next/make-live",
    edit,
    run(async (req, res) => void res.json(await makeNextLive(db, actorOf(req), subscribers))),
  );

  r.delete(
    "/site/carousels/next",
    edit,
    run(async (req, res) => {
      const { version } = deleteNextQuerySchema.parse(req.query);
      await deleteNextCarousel(db, version, actorOf(req));
      res.status(204).end();
    }),
  );

  r.put(
    "/site/slides/:id/image",
    edit,
    rawImage,
    run(async (req: Request<Params>, res) => {
      await setSlideImage(db, req.params.id, bytesOf(req), actorOf(req), subscribers);
      res.status(204).end();
    }),
  );
  r.get(
    "/site/slides/:id/image",
    read,
    run(async (req: Request<Params>, res) => {
      const img = await slideImage(db, req.params.id);
      if (!img) return notFound(res);
      res.type(img.mimeType).set({ "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" }).send(img.bytes);
    }),
  );

  r.get("/site/pins", read, run(async (_req, res) => void res.json(await getPins(db))));
  r.put(
    "/site/pins/:slot",
    edit,
    json,
    run(async (req: Request<Params>, res) => {
      const input = savePinSchema.parse(req.body);
      res.json(await savePin(db, req.params.slot as PinSlot, input, actorOf(req), subscribers));
    }),
  );
  r.post(
    "/site/pins/:slot/pinned",
    edit,
    json,
    run(async (req: Request<Params>, res) => {
      const input = setPinnedSchema.parse(req.body);
      res.json(await setPinned(db, req.params.slot as PinSlot, input, actorOf(req), subscribers));
    }),
  );
  r.put(
    "/site/pins/:slot/image",
    edit,
    rawImage,
    run(async (req: Request<Params>, res) => {
      await setPinImage(db, req.params.slot as PinSlot, bytesOf(req), actorOf(req), subscribers);
      res.status(204).end();
    }),
  );
  r.get(
    "/site/pins/:slot/image",
    read,
    run(async (req: Request<Params>, res) => {
      const img = await pinImage(db, req.params.slot as PinSlot);
      if (!img) return notFound(res);
      res.type(img.mimeType).set({ "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" }).send(img.bytes);
    }),
  );

  r.get(
    "/site/log",
    read,
    run(async (req, res) => {
      const { area, limit } = logQuerySchema.parse(req.query);
      const rows = await db
        .select({ at: siteLog.at, actorName: siteLog.actorName, area: siteLog.area, text: siteLog.text })
        .from(siteLog)
        .where(and(area ? eq(siteLog.area, area) : undefined))
        .orderBy(desc(siteLog.at), desc(siteLog.id))
        .limit(limit);
      res.json(rows.map((row) => ({ ...row, at: row.at.toISOString() })));
    }),
  );

  r.get("/site/live-feed", read, run(async (_req, res) => void res.json(await getLiveFeed(db, liveFeedDefaults))));
  r.put(
    "/site/live-feed",
    edit,
    json,
    run(async (req, res) => {
      const input = liveFeedSchema.parse(req.body);
      res.json(await saveLiveFeed(db, input, actorOf(req), subscribers));
    }),
  );

  r.get(
    "/site/blue-bridge",
    read,
    run(async (_req, res) => void res.json({ ...(await getBlueBridge(db)), warning: BLUE_BRIDGE_WARNING })),
  );
  r.put(
    "/site/blue-bridge",
    blueBridgeAdmin,
    json,
    run(async (req, res) => {
      const input = blueBridgeSchema.parse(req.body);
      res.json(await setBlueBridge(db, input, actorOf(req), { subscribers, timeZone, siteUrl, notify }));
    }),
  );

  r.get("/site/features", read, run(async (_req, res) => void res.json(await featuredWhere(db))));

  r.get("/site/links", read, run(async (_req, res) => void res.json(await getLinks(db))));
  r.put(
    "/site/links",
    edit,
    json,
    run(async (req, res) => {
      const input = saveLinksSchema.parse(req.body);
      res.json(await saveLinks(db, input, actorOf(req), subscribers));
    }),
  );

  r.get(
    "/site/files",
    read,
    run(async (req, res) => {
      const q = filesQuerySchema.parse(req.query);
      res.json(await listFiles(db, q));
    }),
  );
  r.post(
    "/site/files",
    edit,
    needStore,
    query(uploadFileQuerySchema),
    rawFile,
    run(async (req, res) => {
      const q = res.locals.query as z.infer<typeof uploadFileQuerySchema>;
      const view = await uploadFile(db, deps.store!, { name: q.name, bytes: bytesOf(req), replace: q.replace }, actorOf(req));
      res.status(201).json(view);
    }),
  );
  r.delete(
    "/site/files/:id",
    edit,
    needStore,
    run(async (req: Request<Params>, res) => {
      await deleteFile(db, deps.store!, req.params.id, actorOf(req));
      res.status(204).end();
    }),
  );

  return r;
}
