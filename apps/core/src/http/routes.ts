import express, { type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { CORE_ADMIN_DIRECTORY_ROLE, actorOf, requireAnyRole, requireRole } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";
import { EventTooLargeError, orgKeyFromName, termKindSchema, type SubscriberConfig, type TermKind } from "@gcpe/events";
import {
  ADMIN_ONLY_PROFILE_FIELDS,
  AbbreviationTakenError,
  createOrganization,
  deactivateOrganization,
  orgCreateSchema,
  getOrganization,
  listOrganizations,
  orgInputSchema,
  orgProfilePatchSchema,
  patchOrganizationProfile,
  setOrganizationHq,
  setOrganizationPublic,
  SuccessionError,
  succeedOrganization,
  successionInputSchema,
  successionPreview,
  upsertOrganization,
} from "../services/organizations";
import { republishAll } from "../services/republish";
import {
  cancelCabinetChange,
  getOpenCabinetChange,
  previewCabinetChange,
  publishCabinetChange,
  saveCabinetChangeDraft,
  scheduleCabinetChange,
} from "../services/cabinet-changes";
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
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
  if (e instanceof AbbreviationTakenError) return void res.status(409).json({ error: "abbreviation-taken", takenBy: e.takenBy });
  if (e instanceof SuccessionError) return void res.status(422).json({ error: e.message });
  if (e instanceof EventTooLargeError) return void res.status(413).json({ error: "record too large to publish" });
  // Only the label: a failed query's message carries its bound parameters, which can be an email.
  console.error("[core] request failed", safeErrorLabel(e));
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
  r.post(
    "/organizations",
    admin,
    safe(async (req, res) => {
      const input = orgCreateSchema.parse(req.body);
      if (!orgKeyFromName(input.displayName)) return void res.status(400).json({ error: "name must contain a letter or digit" });
      const result = await createOrganization(db, input, subscribers);
      "conflict" in result ? res.status(409).json({ error: "exists", key: result.conflict }) : res.status(201).json(result.record);
    }),
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
      // Refuses a second active holder of an abbreviation, reactivation included (N11): 409 abbreviation-taken.
      const result = await upsertOrganization(db, input, subscribers, { respectStaffEdits: req.query.overwriteStaffEdits !== "true", checkAbbreviation: true });
      if (result.skippedStaffEdit) return void res.status(409).json({ error: "staff-edited" });
      res.json(result.record);
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
  const publicSchema = z.object({ isPublic: z.boolean() });
  r.put(
    "/organizations/:key/public",
    admin,
    safe<{ key: string }>(async (req, res) => {
      const { isPublic } = publicSchema.parse(req.body);
      const record = await setOrganizationPublic(db, req.params.key, isPublic, subscribers);
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );
  r.patch(
    "/organizations/:key/profile",
    requireAnyRole("Core.Admin", "NRMS.SiteEditor"),
    safe<{ key: string }>(async (req, res) => {
      const body: unknown = req.body;
      const isAdmin = req.auth?.roles.includes("Core.Admin") ?? false;
      if (!isAdmin && body && typeof body === "object" && [...ADMIN_ONLY_PROFILE_FIELDS, "isHq", "isPublic"].some((f) => f in body)) {
        return void res.status(403).json({ error: "forbidden" });
      }
      const record = await patchOrganizationProfile(db, req.params.key, orgProfilePatchSchema.parse(body), subscribers);
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
  // New-government spec §4: hand a ministry over to its successors. The preview is Core's part of
  // the Hub's counts; NoD, the Calendar and NRMS each answer for their own.
  r.get(
    "/organizations/:key/succession-preview",
    admin,
    safe<{ key: string }>(async (req, res) => {
      if (!(await getOrganization(db, req.params.key))) return void res.status(404).json({ error: "not found" });
      res.json(await successionPreview(db, req.params.key));
    }),
  );
  r.post(
    "/organizations/:key/succeed",
    admin,
    safe<{ key: string }>(async (req, res) => {
      const record = await succeedOrganization(db, req.params.key, successionInputSchema.parse(req.body), subscribers);
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );

  // New-government spec §5: the staged cabinet change. One change is open (draft or scheduled) at a
  // time, so these routes address "the" open change rather than an id.
  const noOpenChange = (res: Response) => void res.status(404).json({ error: "no open cabinet change" });
  r.get(
    "/cabinet-change",
    admin,
    safe(async (_req, res) => {
      const change = await getOpenCabinetChange(db);
      change ? res.json(change) : noOpenChange(res);
    }),
  );
  const draftSchema = z.object({ operations: z.array(z.unknown()) }).strict();
  r.put(
    "/cabinet-change",
    admin,
    safe(async (req, res) => {
      const { operations } = draftSchema.parse(req.body);
      res.json(await saveCabinetChangeDraft(db, operations, actorOf(req).name));
    }),
  );
  r.post(
    "/cabinet-change/preview",
    admin,
    safe(async (_req, res) => {
      const change = await getOpenCabinetChange(db);
      if (!change) return noOpenChange(res);
      res.json(await previewCabinetChange(db, change.id));
    }),
  );
  r.post(
    "/cabinet-change/publish",
    admin,
    safe(async (_req, res) => {
      const change = await getOpenCabinetChange(db);
      if (!change) return noOpenChange(res);
      const result = await publishCabinetChange(db, change.id, subscribers);
      const status = { published: 200, stale: 409, invalid: 422, "not-open": 404 }[result.result];
      res.status(status).json(result);
    }),
  );
  const scheduleSchema = z.object({ at: z.string().datetime({ offset: true }) }).strict();
  r.post(
    "/cabinet-change/schedule",
    admin,
    safe(async (req, res) => {
      const { at } = scheduleSchema.parse(req.body);
      const change = await getOpenCabinetChange(db);
      if (!change) return noOpenChange(res);
      const result = await scheduleCabinetChange(db, change.id, new Date(at));
      if (result.result === "scheduled") return void res.json(result.change);
      if (result.result === "not-open") return noOpenChange(res);
      if (result.result === "past") return void res.status(422).json({ result: "past", error: "Choose a time in the future." });
      res.status(422).json(result);
    }),
  );
  r.post(
    "/cabinet-change/cancel",
    admin,
    safe(async (_req, res) => {
      const change = await getOpenCabinetChange(db);
      if (!change || !(await cancelCabinetChange(db, change.id))) return noOpenChange(res);
      res.status(204).end();
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
