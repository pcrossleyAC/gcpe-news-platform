import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import { statusText, versionOnlySchema, type ReleaseView } from "@gcpe/nrms-contract";
import type { ObjectStore } from "@gcpe/storage";
import { addReleaseFile, MAX_RELEASE_FILE_BYTES, removeReleaseFile } from "../media/files";
import { addPageImage, MAX_PAGE_IMAGE_BYTES, pageImageBytes, updatePageImage } from "../media/page-images";
import { handleError, run, UUID, type Params } from "./routes";

export interface MediaRouteDeps {
  db: Db;
  /** Where release files go; unset → the release-file routes answer 503. */
  store?: ObjectStore;
}

const int = (re: RegExp) => z.string().regex(re).transform(Number);
const fileQuerySchema = z.object({
  kind: z.enum(["translation", "asset"]),
  version: int(/^\d{1,9}$/),
  name: z.string().min(1).max(1000),
});
const pageImageQuerySchema = z.object({
  name: z.string().trim().min(1).max(100),
  altEn: z.string().max(500).default(""),
  altFr: z.string().max(500).default(""),
  sortOrder: int(/^-?\d{1,6}$/).default("0"),
});
const pageImageUpdateSchema = z
  .object({
    altEn: z.string().max(500).optional(),
    altFr: z.string().max(500).optional(),
    sortOrder: z.number().int().min(-999_999).max(999_999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/** Validates the query string *before* any body is read, so a malformed request never gets buffered. */
const query =
  <T extends z.ZodTypeAny>(schema: T) =>
  (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return void handleError(parsed.error, res);
    res.locals.query = parsed.data as z.infer<T>;
    next();
  };

const bytesOf = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

/**
 * Release file uploads, page images and their JSON siblings.
 *
 * Body parsing: app.ts mounts this router on `/api` *after* `requireBearer` and *before* the
 * global `express.json` — so anonymous callers never get a body buffered (requireBearer answers
 * first), and an upload's raw bytes reach `express.raw` here untouched by the JSON parser. Each
 * route then parses its own body: `express.raw` (any content type — the bytes are judged by
 * magic number, never by the declared type) on the two uploads, placed after the role check and
 * the query check so a viewer's or malformed upload is refused without being read, and a small
 * `express.json` on the two JSON routes. Anything not matched here falls through to the global
 * JSON parser and apiRoutes, unchanged.
 */
export function mediaRoutes(deps: MediaRouteDeps): Router {
  const { db } = deps;
  const r = Router();
  const read = requireAnyRole("NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor");
  const edit = requireRole("NRMS.Editor");
  const images = requireAnyRole("NRMS.SiteEditor", "NRMS.Editor");
  const json = express.json({ limit: "16kb" });
  const rawFile = express.raw({ type: () => true, limit: MAX_RELEASE_FILE_BYTES });
  const rawImage = express.raw({ type: () => true, limit: MAX_PAGE_IMAGE_BYTES });
  const withStatus = (v: ReleaseView) => ({ ...v, statusText: statusText(v, Date.now()) });

  const notFound = (res: Response) => void res.status(404).json({ error: "not found" });
  for (const name of ["id", "fileId"] as const) r.param(name, (_req, res, next, value: string) => (UUID.test(value) ? next() : notFound(res)));
  const needStore = (_req: Request, res: Response, next: NextFunction) =>
    deps.store ? next() : void res.status(503).json({ error: "File storage isn't configured." });

  r.post(
    "/releases/:id/files",
    edit,
    needStore,
    query(fileQuerySchema),
    rawFile,
    run(async (req: Request<Params>, res) => {
      const q = res.locals.query as z.infer<typeof fileQuerySchema>;
      const view = await addReleaseFile(db, deps.store!, req.params.id, { version: q.version, kind: q.kind, fileName: q.name, bytes: bytesOf(req) }, actorOf(req));
      res.status(201).json(withStatus(view));
    }),
  );
  r.post(
    "/releases/:id/files/:fileId/remove",
    edit,
    needStore,
    json,
    run(async (req, res) => {
      const { version } = versionOnlySchema.parse(req.body);
      res.json(withStatus(await removeReleaseFile(db, deps.store!, req.params.id, req.params.fileId, version, actorOf(req))));
    }),
  );

  r.post(
    "/page-images",
    images,
    query(pageImageQuerySchema),
    rawImage,
    run(async (req, res) => {
      const q = res.locals.query as z.infer<typeof pageImageQuerySchema>;
      res.status(201).json(await addPageImage(db, { ...q, bytes: bytesOf(req) }));
    }),
  );
  r.put("/page-images/:id", images, json, run(async (req, res) => void res.json(await updatePageImage(db, req.params.id, pageImageUpdateSchema.parse(req.body)))));
  r.get(
    "/page-images/:id/image",
    read,
    run(async (req, res) => {
      const img = await pageImageBytes(db, req.params.id);
      if (!img) return notFound(res);
      res.type(img.mimeType).set({ "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" }).send(img.bytes);
    }),
  );

  return r;
}
