import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireLevel } from "../actor";
import { previewTransfer, runTransfer, TransferContactNotFoundError, TransferError, transferContacts } from "../transfer";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

// Comm contact ids live in an int4 column; bound them as activity-routes.ts bounds activity ids,
// so an id the database can't hold is a 400 here rather than a query error.
const MAX_CONTACT_ID = 999_999_999;
// A query id is digits only, as a URL :id (activity-routes.ts idOf): no "1e3", "0x10" or " 1".
const queryId = z.string().regex(/^\d{1,9}$/).transform(Number).pipe(z.number().int().positive().max(MAX_CONTACT_ID));
const bodyId = z.number().int().positive().max(MAX_CONTACT_ID);
const pairQuery = z.object({ from: queryId, to: queryId }).strict();
const pairBody = z.object({ from: bodyId, to: bodyId }).strict();

const run = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof TransferError) return void res.status(422).json({ error: e.message });
    if (e instanceof TransferContactNotFoundError) return void res.status(404).json({ error: "not found" });
    if (!sendActivityError(e, res, req)) next(e);
  });

/** Transfer (spec addendum §8.5): Administrator and above, on the server (C140). */
export function transferRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.use("/transfer", requireLevel("Calendar.Administrator"));
  r.get("/transfer/comm-contacts", run(async (req, res) => void res.json(await transferContacts(deps.db, req.calendar!, deps.rules))));
  r.get("/transfer/preview", run(async (req, res) => {
    const q = pairQuery.parse(req.query);
    res.json(await previewTransfer(deps, req.calendar!, q.from, q.to));
  }));
  r.post("/transfer", run(async (req, res) => {
    const b = pairBody.parse(req.body);
    const out = await runTransfer(deps, req.calendar!, b.from, b.to);
    // failed: true means a later batch rolled back after earlier ones committed; 207 carries what did commit.
    res.status(out.failed ? 207 : 200).json(out);
  }));
  return r;
}
