import { Router } from "express";
import { savedFilterCreateSchema, savedFilterOrderSchema, savedFilterRenameSchema } from "@gcpe/calendar-contract";
import { createSavedFilter, deleteSavedFilter, listSavedFilters, renameSavedFilter, reorderSavedFilters, SavedFilterNotFoundError } from "../list/saved-filters";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** An id the saved_filters int4 column can hold; anything else is simply not one of yours. */
function filterIdOf(param: unknown): number {
  if (typeof param !== "string" || !/^\d{1,9}$/.test(param)) throw new SavedFilterNotFoundError();
  return Number(param);
}

/** My Queries (spec addendum §8.1): the owner's only (C141); not frozen (§7.4). */
export function savedFilterRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/saved-filters", runList(async (req, res) => void res.json(await listSavedFilters(deps.db, req.calendar!.userId))));
  r.post("/saved-filters", runList(async (req, res) => {
    res.status(201).json(await createSavedFilter(deps.db, req.calendar!.userId, savedFilterCreateSchema.parse(req.body)));
  }));
  // Before "/saved-filters/:id", which would otherwise take "order" as an id.
  r.put("/saved-filters/order", runList(async (req, res) => {
    res.json(await reorderSavedFilters(deps.db, req.calendar!.userId, savedFilterOrderSchema.parse(req.body).ids));
  }));
  r.put("/saved-filters/:id", runList(async (req, res) => {
    res.json(await renameSavedFilter(deps.db, req.calendar!.userId, filterIdOf(req.params.id), savedFilterRenameSchema.parse(req.body).name));
  }));
  r.delete("/saved-filters/:id", runList(async (req, res) => {
    await deleteSavedFilter(deps.db, req.calendar!.userId, filterIdOf(req.params.id));
    res.status(204).end();
  }));
  return r;
}
