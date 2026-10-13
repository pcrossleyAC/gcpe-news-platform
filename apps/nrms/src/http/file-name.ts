import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";

// Never ?name=: a query string lands in every proxy's access logs, and an embargoed release's
// file names with it. The client percent-encodes the name into this header; the server decodes it.
export const FILE_NAME_HEADER = "x-gcpe-file-name";

const missingName = () => new ZodError([{ code: "custom", path: ["name"], message: "Name the file." }]);

/**
 * Reads the upload's name from {@link FILE_NAME_HEADER} before any body is read, validated by the
 * route's own `schema`, into `res.locals.fileName`. A missing, empty or undecodable header, or a
 * name the schema refuses, is a 400 in the same shape as any other validation error.
 */
export const fileNameHeader =
  (schema: z.ZodType<string>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header(FILE_NAME_HEADER);
    let decoded: string | undefined;
    if (header) {
      try {
        decoded = decodeURIComponent(header);
      } catch {
        decoded = undefined;
      }
    }
    if (decoded === undefined) return void res.status(400).json({ error: "invalid request", issues: missingName().issues });
    const parsed = z.object({ name: schema }).safeParse({ name: decoded });
    if (!parsed.success) return void res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
    res.locals.fileName = parsed.data.name;
    next();
  };
