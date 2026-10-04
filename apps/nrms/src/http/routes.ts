import { Router, type NextFunction, type Request, type Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import type { SubscriberConfig } from "@gcpe/events";
import {
  addDocumentSchema, addTranslationSchema, assetSchema, categoriesSchema, createReleaseSchema, documentLanguageSchema, FEATURE_KINDS, FEATURE_SLOTS, listQuerySchema, metaSchema,
  reorderDocumentsSchema, scheduleSchema, searchQuerySchema, settingsSchema, statusText, versionOnlySchema, type LanguageId, type ReleaseView,
} from "@gcpe/nrms-contract";
import { ReleaseNotFoundError, ReleaseRuleError, ReleaseStateError, ReleaseTooLargeError, VersionConflictError } from "../releases/errors";
import { SiteConflictError, SiteNotFoundError, SiteRuleError } from "../website/errors";
import {
  goTo, listFolder, listItems, listMediaLists, listPageImages, listPageTypes, publication, publications, releaseLog, releaseVisible, searchReleases,
} from "../releases/queries";
import {
  addDocument, addTranslation, createRelease, deleteRelease, removeDocument, removeTranslation, reorderDocuments, saveAsset, saveCategories,
  saveDocumentLanguage, saveMeta, saveSettings,
} from "../releases/service";
import { loadView, writeLog } from "../releases/store";
import { mediaLists, newsReleases, pageImages } from "../db/schema";
import type { ObjectStore } from "@gcpe/storage";
import type { EmbedDeps } from "../media/embeds";
import type { DistributionClient } from "../clients";
import { buildEmailCopy } from "../renditions/email";
import { buildRenditionModel } from "../renditions/model";
import { renderPdf } from "../renditions/pdf";
import { renderText } from "../renditions/text";
import { approve, cancel, schedule, unpublish, type WorkflowDeps } from "../releases/workflow";
import { listCategories } from "../taxonomy";
import { setFeature } from "../website/features";

const featureInputSchema = z
  .object({
    kind: z.enum(FEATURE_KINDS),
    key: z.string().trim().min(1).max(100),
    slot: z.enum(FEATURE_SLOTS),
    on: z.boolean(),
  })
  .refine((v) => v.kind !== "home" || v.key === "default", { message: 'Home slots use the key "default".', path: ["key"] });

export interface RouteDeps {
  db: Db;
  workflow: WorkflowDeps;
  /** "Email me a copy" goes through Distribution; unset → that route answers 503. */
  distribution?: DistributionClient;
  /** Uploaded release files; a hard delete removes the release's files from it. */
  store?: ObjectStore;
  /** Body `<asset>` embed normalisation (Task 7); unset → bodies are sanitised but not normalised. */
  embeds?: EmbedDeps;
  /** Outbound event subscribers, for `release.unpublished`'s clearing of Top/Feature slots and for Top/Feature's own site events. */
  subscribers?: SubscriberConfig[];
}

// A type alias (not an interface) so it satisfies express's ParamsDictionary index signature.
export type Params = { id: string; docId: string; lang: string; pubId: string; fileId: string; slot: string };
export type Handler = (req: Request<Params>, res: Response) => Promise<void>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maps the service layer's typed errors (and zod's) to a response. Returns false for anything
 * else so it reaches jsonErrorHandler as a generic, detail-free 500 (see http-kit/errors.ts).
 */
export function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof ReleaseRuleError) return void res.status(422).json({ error: e.problems.join(" "), problems: e.problems }), true;
  if (e instanceof VersionConflictError || e instanceof ReleaseStateError) return void res.status(409).json({ error: e.message }), true;
  if (e instanceof ReleaseNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof ReleaseTooLargeError) return void res.status(413).json({ error: "release too large" }), true;
  if (e instanceof SiteRuleError) return void res.status(422).json({ errors: e.problems }), true;
  if (e instanceof SiteConflictError) return void res.status(409).json({ error: e.message }), true;
  if (e instanceof SiteNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  return false;
}

export const run = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e) => {
    if (!handleError(e, res)) next(e);
  });

export function apiRoutes(deps: RouteDeps): Router {
  const { db } = deps;
  const r = Router();
  const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor");
  const edit = requireRole("NRMS.Editor");
  const withStatus = (v: ReleaseView) => ({ ...v, statusText: statusText(v, Date.now()) });
  const version = (req: Request) => versionOnlySchema.parse(req.body).version;

  // Malformed path ids are a 404 (not a 400): nothing can exist at that URL.
  const notFound = (res: Response) => void res.status(404).json({ error: "not found" });
  const param = (name: keyof Params, ok: (v: string) => boolean) =>
    r.param(name, (_req, res, next, value: string) => (ok(value) ? next() : notFound(res)));
  param("id", (v) => UUID.test(v));
  param("docId", (v) => UUID.test(v));
  param("lang", (v) => v === "4105" || v === "3084");
  param("pubId", (v) => /^\d{1,15}$/.test(v));
  const opts = () => ({ timeZone: deps.workflow.timeZone, nowMs: Date.now() });

  r.get("/categories", read, run(async (_req, res) => void res.json(await listCategories(db))));

  r.post(
    "/releases",
    edit,
    run(async (req, res) => {
      const view = await createRelease(db, createReleaseSchema.parse(req.body), actorOf(req), deps.embeds);
      res.status(201).json(withStatus(view));
    }),
  );

  r.get(
    "/releases/:id",
    read,
    run(async (req, res) => {
      const view = await loadView(db, req.params.id);
      if (!view || view.status === "deleted") return void res.status(404).json({ error: "not found" });
      res.json(withStatus(view));
    }),
  );

  // The text and PDF versions (legacy Release.ToTextDocument / ToPortableDocument).
  const visibleView = async (id: string) => {
    const view = await loadView(db, id);
    return view && view.status !== "deleted" ? view : null;
  };
  const filename = (v: ReleaseView, ext: string) => `inline; filename="${(v.key ?? v.id).replace(/[^A-Za-z0-9._-]/g, "_")}.${ext}"`;
  r.get(
    "/releases/:id/text",
    read,
    run(async (req, res) => {
      const view = await visibleView(req.params.id);
      if (!view) return notFound(res);
      res.type("text/plain; charset=utf-8").set("content-disposition", filename(view, "txt")).send(renderText(view, opts()));
    }),
  );
  const pdfOf = async (view: ReleaseView, o: ReturnType<typeof opts>) => {
    const imageId = buildRenditionModel(view, o).docs[0]?.pageImageId;
    const [pageImage] = imageId
      ? await db.select({ bytes: pageImages.bytes, mimeType: pageImages.mimeType }).from(pageImages).where(eq(pageImages.id, imageId))
      : [];
    return renderPdf(view, { ...o, pageImage: pageImage ?? null });
  };
  r.get(
    "/releases/:id/pdf",
    read,
    run(async (req, res) => {
      const view = await visibleView(req.params.id);
      if (!view) return notFound(res);
      res.type("application/pdf").set("content-disposition", filename(view, "pdf")).send(await pdfOf(view, opts()));
    }),
  );

  // "Email me a copy": the PDF and text versions, to the signed-in user, through Distribution.
  // Read-only — logged, but no version bump.
  r.post(
    "/releases/:id/email-copy",
    read,
    run(async (req, res) => {
      const view = await visibleView(req.params.id);
      if (!view) return notFound(res);
      if (!deps.distribution) return void res.status(503).json({ error: "Email isn't configured." });
      const email = req.auth?.claims.email;
      if (typeof email !== "string" || email.trim() === "") {
        return void res.status(422).json({ error: "Your account has no email address to send to." });
      }
      const to = email.trim();
      const o = opts();
      const [row] = await db.select().from(newsReleases).where(eq(newsReleases.id, view.id));
      const [item] = await listItems(db, row ? [row] : [], o.nowMs);
      const lists = view.mediaListKeys.length
        ? await db.select({ name: mediaLists.displayName }).from(mediaLists).where(inArray(mediaLists.key, view.mediaListKeys)).orderBy(mediaLists.sortOrder, mediaLists.displayName)
        : [];
      const msg = buildEmailCopy(
        {
          view,
          headline: buildRenditionModel(view, o).docs[0]?.headline ?? item?.headline ?? "",
          leadOrganization: item?.leadOrganization ?? "",
          mediaListNames: lists.map((l) => l.name),
          text: renderText(view, o),
          pdf: await pdfOf(view, o),
          to,
        },
        o,
      );
      try {
        await deps.distribution.send(msg);
      } catch (e) {
        // The status only — never the message, which carries the release's content.
        console.error(`[nrms] email copy of ${view.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        return void res.status(502).json({ error: "The email couldn't be sent — try again." });
      }
      await writeLog(db, view.id, actorOf(req), `Emailed a copy to ${to}`);
      res.status(202).json({ sentTo: to });
    }),
  );

  r.post("/releases/:id/approve", edit, run(async (req, res) => void res.json(withStatus(await approve(db, req.params.id, version(req), actorOf(req), deps.workflow)))));
  r.post("/releases/:id/schedule", edit, run(async (req, res) => void res.json(withStatus(await schedule(db, req.params.id, scheduleSchema.parse(req.body), actorOf(req), deps.workflow)))));
  r.post("/releases/:id/cancel", edit, run(async (req, res) => void res.json(withStatus(await cancel(db, req.params.id, version(req), actorOf(req))))));
  r.post("/releases/:id/unpublish", edit, run(async (req, res) => void res.json(withStatus(await unpublish(db, req.params.id, version(req), actorOf(req))))));
  r.post(
    "/releases/:id/delete",
    edit,
    run(async (req, res) => void res.json({ result: await deleteRelease(db, req.params.id, version(req), actorOf(req), deps.store, deps.subscribers ?? []) })),
  );
  r.post(
    "/releases/:id/features",
    edit,
    run(async (req, res) => {
      const input = featureInputSchema.parse(req.body);
      const view = await setFeature(db, req.params.id, input, actorOf(req), deps.subscribers ?? []);
      res.json(withStatus(view));
    }),
  );

  r.get("/releases", read, run(async (req, res) => void res.json(await listFolder(db, listQuerySchema.parse(req.query), opts()))));
  r.get("/search", read, run(async (req, res) => void res.json(await searchReleases(db, searchQuerySchema.parse(req.query), opts()))));
  r.get(
    "/goto",
    read,
    run(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 2000) : "";
      const id = await goTo(db, q);
      if (!id) return notFound(res);
      res.json({ id });
    }),
  );

  r.get(
    "/releases/:id/log",
    read,
    run(async (req, res) => {
      if (!(await releaseVisible(db, req.params.id))) return notFound(res);
      res.json(await releaseLog(db, req.params.id, req.query.all === "true"));
    }),
  );
  r.get(
    "/releases/:id/publications",
    read,
    run(async (req, res) => {
      if (!(await releaseVisible(db, req.params.id))) return notFound(res);
      res.json(await publications(db, req.params.id));
    }),
  );
  r.get(
    "/releases/:id/publications/:pubId",
    read,
    run(async (req, res) => {
      if (!(await releaseVisible(db, req.params.id))) return notFound(res);
      const record = await publication(db, req.params.id, Number(req.params.pubId));
      if (!record) return notFound(res);
      res.json(record);
    }),
  );

  r.get("/media-lists", read, run(async (_req, res) => void res.json(await listMediaLists(db))));
  r.get("/page-types", read, run(async (_req, res) => void res.json(await listPageTypes(db))));
  r.get("/page-images", read, run(async (_req, res) => void res.json(await listPageImages(db))));

  r.put("/releases/:id/settings", edit, run(async (req, res) => void res.json(withStatus(await saveSettings(db, req.params.id, settingsSchema.parse(req.body), actorOf(req))))));
  r.put("/releases/:id/categories", edit, run(async (req, res) => void res.json(withStatus(await saveCategories(db, req.params.id, categoriesSchema.parse(req.body), actorOf(req))))));
  r.put("/releases/:id/asset", edit, run(async (req, res) => void res.json(withStatus(await saveAsset(db, req.params.id, assetSchema.parse(req.body), actorOf(req))))));
  r.put("/releases/:id/meta", edit, run(async (req, res) => void res.json(withStatus(await saveMeta(db, req.params.id, metaSchema.parse(req.body), actorOf(req))))));

  r.post("/releases/:id/documents", edit, run(async (req, res) => void res.json(withStatus(await addDocument(db, req.params.id, addDocumentSchema.parse(req.body), actorOf(req))))));
  r.put(
    "/releases/:id/documents/order",
    edit,
    run(async (req, res) => void res.json(withStatus(await reorderDocuments(db, req.params.id, reorderDocumentsSchema.parse(req.body), actorOf(req))))),
  );
  r.put(
    "/releases/:id/documents/:docId/:lang",
    edit,
    run(async (req, res) => {
      const lang = Number(req.params.lang) as LanguageId;
      res.json(withStatus(await saveDocumentLanguage(db, req.params.id, req.params.docId, lang, documentLanguageSchema.parse(req.body), actorOf(req), deps.embeds)));
    }),
  );
  r.post(
    "/releases/:id/documents/:docId/translations",
    edit,
    run(async (req, res) => void res.json(withStatus(await addTranslation(db, req.params.id, req.params.docId, addTranslationSchema.parse(req.body), actorOf(req))))),
  );
  r.post(
    "/releases/:id/documents/:docId/remove",
    edit,
    run(async (req, res) => void res.json(withStatus(await removeDocument(db, req.params.id, req.params.docId, version(req), actorOf(req))))),
  );
  r.post(
    "/releases/:id/documents/:docId/translations/:lang/remove",
    edit,
    run(async (req, res) => {
      const lang = Number(req.params.lang) as LanguageId;
      res.json(withStatus(await removeTranslation(db, req.params.id, req.params.docId, lang, version(req), actorOf(req))));
    }),
  );

  return r;
}
