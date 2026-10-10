import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireLevel } from "../actor";
import {
  canEditLookup,
  createLookupRow,
  DuplicateLookupNameError,
  listLookupRows,
  LOOKUPS,
  lookupDef,
  lookupInputSchema,
  LookupRowNotFoundError,
  reorderLookup,
  StaleLookupOrderError,
  updateLookupRow,
  type LookupDef,
} from "../lookups";

class NotFound extends Error {}
class NotEditable extends Error {
  constructor(readonly def: LookupDef) {
    super("not editable");
  }
}

type Params = { name: string; id?: string };
const run = (h: (req: Request<Params>, res: Response) => Promise<void>) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof NotFound || e instanceof LookupRowNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof NotEditable) return void res.status(403).json({ error: `only a System Administrator can change ${e.def.label}` });
    if (e instanceof DuplicateLookupNameError) return void res.status(409).json({ error: "an active row with that name already exists" });
    if (e instanceof StaleLookupOrderError) return void res.status(409).json({ error: "the list changed since you loaded it: reload and try again" });
    next(e);
  });

function summary(def: LookupDef, level: number) {
  return { name: def.name, label: def.label, singular: def.singular, editable: canEditLookup(def, level), minRole: def.minRole, nameMax: def.nameMax, extras: def.extras };
}

function defOf(req: Request<Params>): LookupDef {
  const def = lookupDef(req.params.name);
  if (!def) throw new NotFound();
  return def;
}
function editableDefOf(req: Request<Params>): LookupDef {
  const def = defOf(req);
  if (!canEditLookup(def, req.calendar!.level)) throw new NotEditable(def);
  return def;
}
function idOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.id ?? "")) throw new NotFound();
  return Number(req.params.id);
}

const orderSchema = z.object({ ids: z.array(z.number().int().positive()).max(5000).refine((ids) => new Set(ids).size === ids.length, "duplicate id") }).strict();

/** The generic lookup admin (spec addendum §5.3). Administrators see every lookup; legacy's locked ones need SysAdmin to change. */
export function lookupRoutes(db: Db): Router {
  const r = Router();
  r.use("/lookups", requireLevel("Calendar.Administrator"));
  r.get("/lookups", (req, res) => void res.json(Object.values(LOOKUPS).map((d) => summary(d, req.calendar!.level))));
  r.get("/lookups/:name", run(async (req, res) => {
    const def = defOf(req);
    res.json({ ...summary(def, req.calendar!.level), rows: await listLookupRows(db, def) });
  }));
  r.post("/lookups/:name", run(async (req, res) => {
    const def = editableDefOf(req);
    res.status(201).json(await createLookupRow(db, def, lookupInputSchema(def).parse(req.body)));
  }));
  // Before "/:name/:id", so "order" is never read as a row id.
  r.put("/lookups/:name/order", run(async (req, res) => {
    const def = editableDefOf(req);
    res.json(await reorderLookup(db, def, orderSchema.parse(req.body).ids));
  }));
  r.put("/lookups/:name/:id", run(async (req, res) => {
    const def = editableDefOf(req);
    res.json(await updateLookupRow(db, def, idOf(req), lookupInputSchema(def).parse(req.body)));
  }));
  return r;
}
