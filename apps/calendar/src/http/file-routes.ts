import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { ATTACHMENT_MAX_BYTES, safeString } from "@gcpe/calendar-contract";
import { ActivityNotFoundError } from "../activities/errors";
import { addFile, precheckFileWrite, readFile, removeFile, StoredFileMissingError } from "../activities/files";
import { idOf } from "./activity-routes";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

type Params = { id: string; fileId: string };
type Handler = (req: Request<Params>, res: Response) => Promise<void>;
// Never ?name=: a query string lands in every proxy's access logs, including a confidential
// activity's file name. The client percent-encodes the name into this header; the server decodes it.
const FILE_NAME_HEADER = "x-gcpe-file-name";
const nameSchema = z.object({ name: safeString().min(1).max(1000) }).strict();
const missingName = () => new ZodError([{ code: "custom", path: ["name"], message: "Name the file." }]);

/** A missing, empty or undecodable header is 400, in the same shape as any other validation error. */
function fileNameOf(req: Request<Params>): string {
  const header = req.header(FILE_NAME_HEADER);
  if (!header) throw missingName();
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    throw missingName();
  }
  return nameSchema.parse({ name: decoded }).name;
}

export function fileIdOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.fileId)) throw new ActivityNotFoundError();
  return Number(req.params.fileId);
}

// RFC 5987's attr-char excludes a few characters encodeURIComponent leaves unescaped (the
// percent sign's own delimiters don't apply, but a bare quote or apostrophe would read as the
// ext-value's own charset/language delimiter): percent-encode those too.
const NOT_ATTR_CHAR = /['()*]/g;
const pctEncode = (ch: string) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`;

// RFC 6266's filename* carries the full name, percent-encoded as UTF-8; the quoted filename=
// fallback is built by hand (never left to content-disposition's own heuristics, which only add
// filename* for some non-Latin-1 names) so it is always plain ASCII, with no quote, backslash,
// CR, LF or other control character that could break or extend the header.
function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "file";
  const extValue = encodeURIComponent(fileName).replace(NOT_ATTR_CHAR, pctEncode);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extValue}`;
}

function fail(e: unknown, req: Request<Params>, res: Response, next: NextFunction): void {
  if (e instanceof StoredFileMissingError) {
    console.error("[calendar] a stored file is missing", `${req.method} ${req.baseUrl}${req.path}`);
    return void res.status(404).json({ error: "not found" });
  }
  if (!sendActivityError(e, res, req)) next(e);
}
/** The final handler of a route. */
const run = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => void h(req, res).catch((e: unknown) => fail(e, req, res, next));
/** A check that lets the request on when it passes. */
const guard = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => void h(req, res).then(() => next(), (e: unknown) => fail(e, req, res, next));

/**
 * Attachments (spec addendum §8.4). Mounted after requireCalendarActor and before the JSON parser,
 * so an upload's raw bytes reach express.raw untouched, and only after every check a save would
 * make has passed: a caller who can't attach the file is refused without it being buffered.
 */
export function fileRoutes(deps: ApiDeps): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES });
  const needStore = (_req: Request, res: Response, next: NextFunction) =>
    deps.store ? next() : void res.status(503).json({ error: "File storage isn't configured." });
  // A declared Content-Length over the limit is refused without reading any of the body. A
  // chunked body (no Content-Length) still relies on `raw`'s own streamed limit.
  const declaredSize = (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.header("content-length"));
    if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
      res.set("Connection", "close");
      return void res.status(413).json({ error: "A file can be at most 25 MB." });
    }
    next();
  };

  r.post(
    "/activities/:id/files",
    needStore,
    guard(async (req, res) => {
      res.locals.fileName = fileNameOf(req);
      await precheckFileWrite(deps, req.calendar!, idOf(req));
    }),
    declaredSize,
    raw,
    run(async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.status(201).json(await addFile(deps, deps.store!, req.calendar!, idOf(req), res.locals.fileName as string, bytes));
    }),
  );
  r.delete("/activities/:id/files/:fileId", needStore, run(async (req, res) => {
    res.json(await removeFile(deps, deps.store!, req.calendar!, idOf(req), fileIdOf(req)));
  }));
  r.get("/activities/:id/files/:fileId", needStore, run(async (req, res) => {
    const f = await readFile(deps, deps.store!, req.calendar!, idOf(req), fileIdOf(req));
    // setHeader, not res.set/res.type: Express's Content-Type setter adds a charset by mime
    // lookup (e.g. "text/plain" becomes "text/plain; charset=utf-8"), and the type here must be
    // exactly what the list (or downloadContentType's fallback) says, never augmented.
    res.setHeader("Content-Type", f.contentType);
    res.setHeader("Content-Disposition", attachmentDisposition(f.fileName));
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.send(f.bytes);
  }));
  return r;
}
