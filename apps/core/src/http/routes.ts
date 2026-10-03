import express, { type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireRole } from "@gcpe/auth";
import { termKindSchema, type SubscriberConfig, type TermKind } from "@gcpe/events";
import { deactivateOrganization, getOrganization, listOrganizations, orgInputSchema, upsertOrganization } from "../services/organizations";
import { republishAll } from "../services/republish";
import { deactivateTerm, getTerm, listTerms, termInputSchema, upsertTerm } from "../services/terms";

function parseKind(req: Request, res: Response): TermKind | null {
  const parsed = termKindSchema.safeParse(req.params.kind);
  if (!parsed.success) {
    res.status(404).json({ error: "unknown term kind" });
    return null;
  }
  return parsed.data;
}

function badRequest(res: Response, e: unknown) {
  res.status(400).json({ error: e instanceof ZodError ? e.issues : String(e) });
}

export function apiRoutes(db: Db, subscribers: SubscriberConfig[]): express.Router {
  const r = express.Router();
  const admin = requireRole("Core.Admin");

  r.get("/organizations", async (_req, res) => void res.json(await listOrganizations(db)));
  r.get("/organizations/:key", async (req, res) => {
    const org = await getOrganization(db, req.params.key);
    org ? res.json(org) : res.status(404).json({ error: "not found" });
  });
  r.put("/organizations/:key", admin, async (req, res) => {
    try {
      const input = orgInputSchema.parse(req.body);
      if (input.key !== req.params.key) return void res.status(400).json({ error: "body key must match path" });
      res.json((await upsertOrganization(db, input, subscribers)).record);
    } catch (e) {
      badRequest(res, e);
    }
  });
  r.post("/organizations/:key/deactivate", admin, async (req: Request<{ key: string }>, res) => {
    (await deactivateOrganization(db, req.params.key, subscribers)) ? res.status(204).end() : res.status(404).json({ error: "not found" });
  });

  r.get("/terms/:kind", async (req, res) => {
    const kind = parseKind(req, res);
    if (kind) res.json(await listTerms(db, kind));
  });
  r.get("/terms/:kind/:key", async (req, res) => {
    const kind = parseKind(req, res);
    if (!kind) return;
    const term = await getTerm(db, kind, req.params.key);
    term ? res.json(term) : res.status(404).json({ error: "not found" });
  });
  r.put("/terms/:kind/:key", admin, async (req, res) => {
    const kind = parseKind(req, res);
    if (!kind) return;
    try {
      const input = termInputSchema.parse(req.body);
      if (input.kind !== kind || input.key !== req.params.key) return void res.status(400).json({ error: "body kind/key must match path" });
      res.json((await upsertTerm(db, input, subscribers)).record);
    } catch (e) {
      badRequest(res, e);
    }
  });
  r.post("/terms/:kind/:key/deactivate", admin, async (req: Request<{ kind: string; key: string }>, res) => {
    const kind = parseKind(req, res);
    if (!kind) return;
    (await deactivateTerm(db, kind, req.params.key, subscribers)) ? res.status(204).end() : res.status(404).json({ error: "not found" });
  });

  r.post("/admin/republish", admin, async (_req, res) => {
    res.status(202).json({ enqueued: await republishAll(db, subscribers) });
  });
  return r;
}
