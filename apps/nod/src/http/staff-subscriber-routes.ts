import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireAnyRole } from "@gcpe/auth";
import { safeErrorLabel } from "../subscribe/journeys";
import { getSubscriberDetail, listHistory, listOptions, searchSubscribers, STATUS_FILTERS } from "../staff-subscribers/read";

/** Spec §8: Viewer reads the Subscribers section; Editor and Admin also change it. */
export const NOD_READ_ROLES = ["NoD.Viewer", "NoD.Editor", "NoD.Admin"] as const;
export const NOD_WRITE_ROLES = ["NoD.Editor", "NoD.Admin"] as const;

const idParam = z.string().uuid();
/** An empty string in the JSON body (a form field cleared rather than removed) means the same
 * as the field being absent — handled by preprocessing it to `undefined` before the field's
 * own `.default()` runs, rather than letting it fail validation. */
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const searchBody = z.object({
  q: z.string().max(254).default(""),
  status: z.preprocess(emptyToUndefined, z.enum(STATUS_FILTERS).default("all")),
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100_000).default(1)),
});

/** Maps this router's domain errors to responses; false for anything else. Grows with the
 * write routes. */
function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  return false;
}

/**
 * Every handler here runs through this instead of `next(err)`: these routes' queries bind
 * email addresses and search terms, a DrizzleQueryError's message carries its bound params,
 * and the shared jsonErrorHandler logs the whole error. So an unexpected error is answered
 * here as a bare 500 and logged by its Postgres code or error name only.
 */
export function privateErrors<P>(handler: (req: Request<P>, res: Response) => Promise<void>) {
  return (req: Request<P>, res: Response): void => {
    handler(req, res).catch((e: unknown) => {
      if (mapError(e, res)) return;
      console.error("[nod] staff subscriber request failed", safeErrorLabel(e));
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    });
  };
}

const notFound = (res: Response) => void res.status(404).json({ error: "not found" });

export function staffSubscriberRoutes(db: Db): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);

  // A search term is usually an email address, and a GET's query string is recorded by every
  // reverse proxy in front of this (SiteGround nginx, the OpenShift router) and by browsers —
  // so the term travels in a POST body instead, never in the URL. Registered ahead of
  // `/subscribers/:id` below so a literal path segment of "search" is never mistaken for an
  // id, and distinct from a future `POST /subscribers` (add, Task 4) by path, not just method.
  r.post("/subscribers/search", read, privateErrors(async (req, res) => {
    res.json(await searchSubscribers(db, searchBody.parse(req.body)));
  }));

  r.get("/subscriber-list-options", read, privateErrors(async (_req, res) => {
    res.json(await listOptions(db));
  }));

  r.get("/subscribers/:id", read, privateErrors<{ id: string }>(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const detail = await getSubscriberDetail(db, id.data);
    if (!detail) return notFound(res);
    res.json(detail);
  }));

  r.get("/subscribers/:id/history", read, privateErrors<{ id: string }>(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const items = await listHistory(db, id.data);
    if (!items) return notFound(res);
    res.json({ items });
  }));

  return r;
}
