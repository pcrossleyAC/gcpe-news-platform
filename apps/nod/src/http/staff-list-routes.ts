import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { ListNotFoundError, ManagedInNrmsError, OrderOutOfDateError, reorderCategories, reorderLists, setCategoryEnabled, setListEnabled, staffListsView } from "../staff-lists";
import { privateErrorsWith } from "./private-errors";
import { NOD_READ_ROLES } from "./staff-subscriber-routes";

/** Spec §8: NoD.Admin alone changes categories and lists (and runs Operations). */
export const NOD_ADMIN_ROLES = ["NoD.Admin"] as const;

const enabledBody = z.object({ enabled: z.boolean() });
const categoryOrderBody = z.object({ keys: z.array(z.string().min(1).max(100)).min(1).max(50) });
const listOrderBody = z.object({ listKeys: z.array(z.string().min(1).max(300)).min(1).max(2000) });

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof ListNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof ManagedInNrmsError) return void res.status(409).json({ error: "managed-in-nrms" }), true;
  if (e instanceof OrderOutOfDateError) return void res.status(409).json({ error: "order-out-of-date" }), true;
  return false;
}
const privateErrors = privateErrorsWith(mapError, "staff list request");

export function staffListRoutes(db: Db): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);
  const admin = requireAnyRole(...NOD_ADMIN_ROLES);

  r.get("/list-categories", read, privateErrors(async (_req, res) => {
    res.json(await staffListsView(db));
  }));

  // Registered ahead of "/list-categories/:key", so "order" is never taken for a category key.
  r.put("/list-categories/order", admin, privateErrors(async (req, res) => {
    await reorderCategories(db, categoryOrderBody.parse(req.body).keys, actorOf(req).name);
    res.json({ ok: true });
  }));

  r.put("/list-categories/:key/list-order", admin, privateErrors<{ key: string }>(async (req, res) => {
    await reorderLists(db, req.params.key, listOrderBody.parse(req.body).listKeys, actorOf(req).name);
    res.json({ ok: true });
  }));

  r.put("/list-categories/:key", admin, privateErrors<{ key: string }>(async (req, res) => {
    res.json(await setCategoryEnabled(db, req.params.key, enabledBody.parse(req.body).enabled, actorOf(req).name));
  }));

  r.put("/lists/:listKey", admin, privateErrors<{ listKey: string }>(async (req, res) => {
    res.json(await setListEnabled(db, req.params.listKey, enabledBody.parse(req.body).enabled, actorOf(req).name));
  }));

  return r;
}
