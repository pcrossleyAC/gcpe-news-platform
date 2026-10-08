import express, { type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { CORE_ADMIN_DIRECTORY_ROLE, requireAnyRole, requireRole } from "@gcpe/auth";
import { EventTooLargeError, termKindSchema, type SubscriberConfig, type TermKind } from "@gcpe/events";
import { deactivateOrganization, getOrganization, listOrganizations, orgInputSchema, setOrganizationHq, upsertOrganization } from "../services/organizations";
import { republishAll } from "../services/republish";
import { deactivateTerm, getTerm, listTerms, termInputSchema, upsertTerm } from "../services/terms";
import { adminEmails } from "../services/users";
import { CALENDAR_ACCESS_ROLES, calendarAccessRouter } from "./calendar-access";
import { usersRouter } from "./users";

function parseKind(req: Request<{ kind: string }>, res: Response): TermKind | null {
  const parsed = termKindSchema.safeParse(req.params.kind);
  if (!parsed.success) {
    res.status(404).json({ error: "unknown term kind" });
    return null;
  }
  return parsed.data;
}

function handleError(res: Response, e: unknown) {
  if (e instanceof ZodError) return void res.status(400).json({ error: e.issues });
  if (e instanceof EventTooLargeError) return void res.status(413).json({ error: "record too large to publish" });
  console.error("[core] request failed", e);
  if (res.headersSent) return void res.end();
  res.status(500).json({ error: "internal error" });
}

/** Every route goes through here so failures share one response shape and never leak details. */
function safe<P>(fn: (req: Request<P>, res: Response) => Promise<void>) {
  return (req: Request<P>, res: Response) => fn(req, res).catch((e: unknown) => handleError(res, e));
}

export function apiRoutes(db: Db, subscribers: SubscriberConfig[]): express.Router {
  const r = express.Router();
  const admin = requireRole("Core.Admin");

  r.get(
    "/organizations",
    safe(async (_req, res) => void res.json(await listOrganizations(db))),
  );
  r.get(
    "/organizations/:key",
    safe<{ key: string }>(async (req, res) => {
      const org = await getOrganization(db, req.params.key);
      org ? res.json(org) : res.status(404).json({ error: "not found" });
    }),
  );
  r.put(
    "/organizations/:key",
    admin,
    safe<{ key: string }>(async (req, res) => {
      const input = orgInputSchema.parse(req.body);
      if (input.key !== req.params.key) return void res.status(400).json({ error: "body key must match path" });
      res.json((await upsertOrganization(db, input, subscribers)).record);
    }),
  );
  const hqSchema = z.object({ isHq: z.boolean() });
  r.put(
    "/organizations/:key/hq",
    admin,
    safe<{ key: string }>(async (req, res) => {
      const { isHq } = hqSchema.parse(req.body);
      const record = await setOrganizationHq(db, req.params.key, isHq, subscribers);
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );
  r.post(
    "/organizations/:key/deactivate",
    admin,
    safe<{ key: string }>(async (req, res) => {
      (await deactivateOrganization(db, req.params.key, subscribers)) ? res.status(204).end() : res.status(404).json({ error: "not found" });
    }),
  );

  r.get(
    "/terms/:kind",
    safe<{ kind: string }>(async (req, res) => {
      const kind = parseKind(req, res);
      if (kind) res.json(await listTerms(db, kind));
    }),
  );
  r.get(
    "/terms/:kind/:key",
    safe<{ kind: string; key: string }>(async (req, res) => {
      const kind = parseKind(req, res);
      if (!kind) return;
      const term = await getTerm(db, kind, req.params.key);
      term ? res.json(term) : res.status(404).json({ error: "not found" });
    }),
  );
  r.put(
    "/terms/:kind/:key",
    admin,
    safe<{ kind: string; key: string }>(async (req, res) => {
      const kind = parseKind(req, res);
      if (!kind) return;
      const input = termInputSchema.parse(req.body);
      if (input.kind !== kind || input.key !== req.params.key) return void res.status(400).json({ error: "body kind/key must match path" });
      res.json((await upsertTerm(db, input, subscribers)).record);
    }),
  );
  r.post(
    "/terms/:kind/:key/deactivate",
    admin,
    safe<{ kind: string; key: string }>(async (req, res) => {
      const kind = parseKind(req, res);
      if (!kind) return;
      (await deactivateTerm(db, kind, req.params.key, subscribers)) ? res.status(204).end() : res.status(404).json({ error: "not found" });
    }),
  );

  r.post(
    "/admin/republish",
    admin,
    safe(async (_req, res) => void res.status(202).json({ enqueued: await republishAll(db, subscribers) })),
  );

  // Plan 3d task 4: NRMS's Project Blue Bridge notify — a narrow, read-only directory lookup,
  // open to Core.Admin itself or NRMS's own Core.AdminDirectory service token. Deliberately not
  // under /users (that's the full admin-only user-management surface).
  r.get(
    "/directory/admin-emails",
    requireAnyRole("Core.Admin", CORE_ADMIN_DIRECTORY_ROLE),
    safe(async (_req, res) => void res.json({ emails: await adminEmails(db) })),
  );

  r.use("/calendar-access", requireAnyRole(...CALENDAR_ACCESS_ROLES), calendarAccessRouter(db, subscribers));
  r.use("/users", admin, usersRouter(db, subscribers));
  return r;
}
