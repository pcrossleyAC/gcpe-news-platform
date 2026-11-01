import express, { Router } from "express";
import { z } from "zod";
import type { Db, TestClock } from "@gcpe/db-kit";
import { actorOf, requireRole } from "@gcpe/auth";
import type { SubscriberConfig } from "@gcpe/events";
import {
  createGovernmentTerm,
  deleteGovernmentTerm,
  GovernmentTermConflictError,
  GovernmentTermNotFoundError,
  isIsoDate,
  listGovernmentTerms,
  updateGovernmentTerm,
} from "../government-terms";
import { handleError, run, UUID, type Params } from "./routes";

export interface GovernmentTermRouteDeps {
  db: Db;
  subscribers: SubscriberConfig[];
  timeZone: string;
  /** Test seam: the clock "today" is read from. */
  now?: TestClock;
}

const startDate = z.string().refine(isIsoDate, "must be a date as YYYY-MM-DD");
const label = z
  .string()
  .trim()
  .max(255)
  .transform((s) => (s === "" ? null : s))
  .nullable();
const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((s) => {
    try {
      return new URL(s).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https:// URL")
  .nullable();
const createSchema = z.object({ startDate, label: label.optional() }).strict();
const patchSchema = z.object({ startDate: startDate.optional(), label: label.optional(), legacyArchiveUrl: httpsUrl.optional() }).strict();

/** Government-term administration (Core.Admin). Mounted before the global JSON parser; owns a small one. */
export function governmentTermRoutes(deps: GovernmentTermRouteDeps): Router {
  const { db } = deps;
  const opts = { timeZone: deps.timeZone, subscribers: deps.subscribers, now: deps.now };
  const admin = requireRole("Core.Admin");
  const json = express.json({ limit: "10kb" });
  const r = Router();
  r.param("id", (_req, res, next, value: string) => (UUID.test(value) ? next() : void res.status(404).json({ error: "not found" })));

  // Wraps `run` so the term errors map to their statuses; everything else goes to handleError/500.
  const term = (h: Parameters<typeof run>[0]) =>
    run(async (req, res) => {
      try {
        await h(req, res);
      } catch (e) {
        if (e instanceof GovernmentTermConflictError) return void res.status(409).json({ error: e.message });
        if (e instanceof GovernmentTermNotFoundError) return void res.status(404).json({ error: "not found" });
        if (handleError(e, res)) return;
        throw e;
      }
    });

  r.get("/government-terms", admin, term(async (_req, res) => void res.json(await db.transaction((tx) => listGovernmentTerms(tx, opts)))));
  r.post(
    "/government-terms",
    admin,
    json,
    term(async (req, res) => {
      const input = createSchema.parse(req.body);
      res.status(201).json(await db.transaction((tx) => createGovernmentTerm(tx, input, { ...opts, actor: actorOf(req) })));
    }),
  );
  r.patch(
    "/government-terms/:id",
    admin,
    json,
    term(async (req: express.Request<Params>, res) => {
      const patch = patchSchema.parse(req.body);
      res.json(await db.transaction((tx) => updateGovernmentTerm(tx, req.params.id, patch, { ...opts, actor: actorOf(req) })));
    }),
  );
  r.delete(
    "/government-terms/:id",
    admin,
    term(async (req: express.Request<Params>, res) => {
      await db.transaction((tx) => deleteGovernmentTerm(tx, req.params.id, { ...opts, actor: actorOf(req) }));
      res.status(204).end();
    }),
  );
  return r;
}
