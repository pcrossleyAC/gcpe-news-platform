import express, { Router, type NextFunction, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { wallClockToInstant } from "@gcpe/config";
import { localDateTime } from "@gcpe/nrms-contract";
import { SECTION_KEYS, type SiteSettings } from "@gcpe/site-settings";
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
  SLIDE_IMAGE_UPLOAD,
  stageSlideImage,
  type PinSlot,
} from "../website/carousel";
import { MAX_SITE_IMAGE_BYTES, type SlideImageFiles } from "../website/slide-images";
import { actionLabelField, httpOrEmpty, justifySchema, slideInputSchema } from "../website/slide-input";
import { deleteFile, listFiles, uploadFile, MAX_SITE_FILE_BYTES } from "../website/files";
import { featuredWhere } from "../website/features";
import { getLinks, saveLinks } from "../website/links";
import { getBlueBridge, getLiveFeed, saveLiveFeed, setBlueBridge, type LiveFeedDefaults } from "../website/settings";
import { parseLocalDateTime } from "../releases/workflow";
import {
  discardDraft,
  getRevision,
  getSettingsState,
  listHistory,
  publishSettings,
  rebaseDraft,
  restoreRevision,
  saveDraft,
  type PublishResult,
} from "../website/site-settings";
import { fileNameHeader } from "./file-name";
import { run, UUID, type Params } from "./routes";

export interface SiteRouteDeps {
  db: Db;
  subscribers: SubscriberConfig[];
  timeZone: string;
  /** Live Feed URLs to show when none is configured (env `LIVE_WEBCAST_*_URL_DEFAULT`). */
  liveFeedDefaults: LiveFeedDefaults;
  /** What site settings show before anything is published; unset → the /site/settings routes answer 503. */
  siteSettingsDefaults?: SiteSettings;
  /** Where general files go; unset → the file upload/delete routes answer 503. */
  store?: ObjectStore;
  /** The site-file upload cap (default MAX_SITE_FILE_BYTES). */
  maxSiteFileBytes?: number;
  /** Where carousel and emergency pin images go, content-addressed (spec addendum §6.4). */
  slideFiles: SlideImageFiles;
  /** Plan 3d task 4: the public site's base URL, named in Project Blue Bridge's notify subject. */
  siteUrl: string;
  /** Plan 3d task 4: Project Blue Bridge's post-commit notify. */
  notify: (subject: string, text: string) => Promise<void>;
}

/** Legacy ProjectBlueBridge.aspx:50 — shown on every GET so the staff app can display it next to the switch. */
export const BLUE_BRIDGE_WARNING = "Do not click OK unless you have approval from IGRS";

/** Slide/pin images' 2 MiB cap, defined beside the slide image store (website/slide-images.ts). */
export { MAX_SITE_IMAGE_BYTES };
const SLOT = /^(primary|secondary)$/;
const AREAS: readonly SiteLogArea[] = ["carousel", "pins", "live-feed", "blue-bridge", "links", "files", "features", "settings"];

const dateish = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be a valid date/time");
/**
 * 3f task 5 fix round 1 (controller ruling): exactly one of `goLiveAt` (an already-resolved
 * instant with an explicit offset — today's form) or `goLiveAtLocal` (a BC wall-clock time with
 * no offset, converted server-side with the tenant's tzdata — see
 * ../website/carousel.ts's `resolveGoLiveAt`) must be given; neither or both is a 400. Same XOR
 * shape as `@gcpe/nrms-contract`'s `scheduleSchema` (`publishAt`/`publishAtLocal`), whose
 * `localDateTime` this reuses rather than copying.
 */
const createNextSchema = z
  .object({ goLiveAt: dateish.optional(), goLiveAtLocal: localDateTime.optional() })
  .refine((v) => (v.goLiveAt !== undefined) !== (v.goLiveAtLocal !== undefined), {
    message: "Provide exactly one of goLiveAt or goLiveAtLocal.",
  });
/** Saving a carousel's go-live time is optional (slides alone can be saved without touching
 * it) — so, unlike `createNextSchema`, at most one of `goLiveAt`/`goLiveAtLocal` may be given
 * (settingsSchema's `plannedPublishAt`/`plannedPublishAtLocal` shape), not exactly one. */
const saveCarouselSchema = z
  .object({
    version: z.number().int().positive(),
    goLiveAt: dateish.optional(),
    goLiveAtLocal: localDateTime.optional(),
    // Audit #9: a slide may name an image staged by POST /site/slide-images, set by this save.
    slides: z.array(slideInputSchema.extend({ imageUpload: z.string().regex(SLIDE_IMAGE_UPLOAD).optional() })),
  })
  .refine((v) => !(v.goLiveAt !== undefined && v.goLiveAtLocal !== undefined), {
    message: "Provide at most one of goLiveAt or goLiveAtLocal.",
  });
const savePinSchema = z.object({
  version: z.number().int().positive(),
  headline: z.string().max(255),
  summary: z.string().max(255),
  actionUrl: httpOrEmpty,
  actionLabel: actionLabelField,
  facebookPostUrl: httpOrEmpty,
  justify: justifySchema,
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
const uploadFileQuerySchema = z
  .object({ replace: z.enum(["true", "false"]).default("false").transform((v) => v === "true") })
  .strict();
const siteFileName = z.string().min(1).max(1000);

const sectionKey = z.enum(SECTION_KEYS);
const baseRevision = z.number().int().positive().nullable();
const sectionBody = z.object({ section: sectionKey, value: z.unknown() });
const draftBody = sectionBody.extend({ baseRevision });
const publishBody = draftBody.extend({ note: z.string().max(500).optional() });
const restoreBody = z.object({ revision: z.number().int().positive(), baseRevision });
const REVISION = /^[1-9]\d{0,8}$/;

/**
 * The Hub sends the banner's schedule as BC wall-clock times (`startsAtLocal`/`endsAtLocal`, a
 * `localDateTime` or null); the document stores instants. Convert with the tenant's tzdata (as
 * the carousel's `goLiveAtLocal` does); a local key wins over an instant of the same name.
 * A malformed local time is a ZodError (400).
 */
function bannerWithInstants(value: unknown, timeZone: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const { startsAtLocal, endsAtLocal, ...rest } = value as Record<string, unknown>;
  const out: Record<string, unknown> = rest;
  for (const [key, local] of [["startsAt", startsAtLocal], ["endsAt", endsAtLocal]] as const) {
    if (local === undefined) continue;
    const parsed = localDateTime.nullable().parse(local);
    out[key] = parsed === null ? null : wallClockToInstant(parseLocalDateTime(parsed), timeZone).toISOString();
  }
  return out;
}

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
  const { db, subscribers, timeZone, liveFeedDefaults, siteUrl, notify, slideFiles, siteSettingsDefaults } = deps;
  const r = Router();
  const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor", "Core.Admin");
  const edit = requireRole("NRMS.SiteEditor");
  // Spec: read = NRMS.SiteEditor or Core.Admin (not the broader `read`); write = NRMS.SiteEditor.
  const settingsRead = requireAnyRole("NRMS.SiteEditor", "Core.Admin");
  const blueBridgeAdmin = requireRole("Core.Admin");
  const json = express.json({ limit: "64kb" });
  const rawImage = express.raw({ type: () => true, limit: MAX_SITE_IMAGE_BYTES });
  // Site files (any type, up to 512 MiB) are streamed to the store, never parsed into memory: a
  // declared length over the cap is refused before reading; a chunked body is cut off while streaming.
  const maxSiteFile = deps.maxSiteFileBytes ?? MAX_SITE_FILE_BYTES;
  const declaredSize = (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > maxSiteFile) return void res.status(413).set("connection", "close").json({ error: `A file can be at most ${Math.round(maxSiteFile / 1024 / 1024)} MB.` });
    next();
  };
  const needStore = (_req: Request, res: Response, next: NextFunction) =>
    deps.store ? next() : void res.status(503).json({ error: "File storage isn't configured." });

  r.param("id", (_req, res, next, value: string) => (UUID.test(value) ? next() : notFound(res)));
  r.param("revision", (_req, res, next, value: string) => (REVISION.test(value) ? next() : notFound(res)));
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
      res.json(await saveCarousel(db, req.params.id, input, actorOf(req), subscribers, timeZone, slideFiles));
    }),
  );

  r.post(
    "/site/carousels/next/make-live",
    edit,
    run(async (req, res) => void res.json(await makeNextLive(db, actorOf(req), subscribers, slideFiles))),
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

  // Audit #9: stages a slide image for the next carousel save (nothing public changes until then).
  r.post(
    "/site/slide-images",
    edit,
    rawImage,
    run(async (req, res) => void res.status(201).json(await stageSlideImage(slideFiles, bytesOf(req)))),
  );
  r.put(
    "/site/slides/:id/image",
    edit,
    rawImage,
    run(async (req: Request<Params>, res) => {
      await setSlideImage(db, req.params.id, bytesOf(req), actorOf(req), subscribers, slideFiles);
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
      res.json(await savePin(db, req.params.slot as PinSlot, input, actorOf(req), subscribers, slideFiles));
    }),
  );
  r.post(
    "/site/pins/:slot/pinned",
    edit,
    json,
    run(async (req: Request<Params>, res) => {
      const input = setPinnedSchema.parse(req.body);
      res.json(await setPinned(db, req.params.slot as PinSlot, input, actorOf(req), subscribers, slideFiles));
    }),
  );
  r.put(
    "/site/pins/:slot/image",
    edit,
    rawImage,
    run(async (req: Request<Params>, res) => {
      await setPinImage(db, req.params.slot as PinSlot, bytesOf(req), actorOf(req), subscribers, slideFiles);
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
    fileNameHeader(siteFileName),
    declaredSize,
    run(async (req, res) => {
      const q = res.locals.query as z.infer<typeof uploadFileQuerySchema>;
      const view = await uploadFile(db, deps.store!, { name: res.locals.fileName as string, source: req, replace: q.replace, maxBytes: maxSiteFile }, actorOf(req));
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

  // ---- Site settings (site-settings plan, Task 4; spec "Storage and publishing — NRMS") ----
  const needDefaults = (_req: Request, res: Response, next: NextFunction) =>
    siteSettingsDefaults ? next() : void res.status(503).json({ error: "Site settings defaults aren't configured." });
  const defaults = () => siteSettingsDefaults!;
  const sectionInput = (b: { section: z.infer<typeof sectionKey>; value?: unknown }) => ({
    section: b.section,
    value: b.section === "banner" ? bannerWithInstants(b.value, timeZone) : b.value,
  });
  /** Invalid ⇒ 422 `{ errors: ["field: message"], fieldErrors }`; stale base ⇒ 409 `{ error: "published", code: "published", live, differing }`. */
  const notPublished = (res: Response, result: Exclude<PublishResult, { result: "published" }>) =>
    result.result === "invalid"
      ? void res.status(422).json({ errors: result.errors.map((e) => `${e.field}: ${e.message}`), fieldErrors: result.errors })
      : void res.status(409).json({ error: "published", code: "published", live: result.live, differing: result.differing });

  r.get("/site/settings", settingsRead, needDefaults, run(async (req, res) => void res.json(await getSettingsState(db, actorOf(req), defaults()))));
  // The tenant's own defaults, for the Hub's "Reset to defaults" buttons (the state above only carries them while nothing is saved).
  r.get("/site/settings/defaults", settingsRead, needDefaults, run(async (_req, res) => void res.json(defaults())));
  r.put(
    "/site/settings/draft",
    edit,
    needDefaults,
    json,
    run(async (req, res) => {
      const b = draftBody.parse(req.body);
      res.json(await saveDraft(db, actorOf(req), defaults(), { ...sectionInput(b), baseRevision: b.baseRevision }));
    }),
  );
  r.post(
    "/site/settings/publish",
    edit,
    needDefaults,
    json,
    run(async (req, res) => {
      const b = publishBody.parse(req.body);
      const actor = actorOf(req);
      const result = await publishSettings(db, actor, defaults(), subscribers, { ...sectionInput(b), baseRevision: b.baseRevision, note: b.note });
      if (result.result !== "published") return notPublished(res, result);
      res.json({ revision: result.revision, state: await getSettingsState(db, actor, defaults()) });
    }),
  );
  r.delete(
    "/site/settings/draft",
    edit,
    needDefaults,
    run(async (req, res) => {
      await discardDraft(db, actorOf(req));
      res.status(204).end();
    }),
  );
  r.post(
    "/site/settings/rebase",
    edit,
    needDefaults,
    json,
    run(async (req, res) => void res.json(await rebaseDraft(db, actorOf(req), defaults(), sectionInput(sectionBody.parse(req.body))))),
  );
  r.get(
    "/site/settings/history",
    settingsRead,
    run(async (_req, res) => {
      const revisions = await listHistory(db);
      res.json({ live: revisions[0]?.revision ?? null, revisions });
    }),
  );
  r.get(
    "/site/settings/history/:revision",
    settingsRead,
    needDefaults,
    run(async (req: Request<Params>, res) => {
      // Filled from the tenant defaults and compared filled, so a revision from before a later
      // part existed shows that part as the site does and doesn't report it as changed.
      const found = await getRevision(db, Number(req.params.revision), defaults());
      if (!found) return notFound(res);
      res.json(found);
    }),
  );
  r.post(
    "/site/settings/restore",
    edit,
    needDefaults,
    json,
    run(async (req, res) => {
      const b = restoreBody.parse(req.body);
      const result = await restoreRevision(db, actorOf(req), defaults(), subscribers, b);
      if (result.result === "not-found") return notFound(res);
      if (result.result !== "published") return notPublished(res, result);
      res.json({ revision: result.revision });
    }),
  );

  return r;
}
