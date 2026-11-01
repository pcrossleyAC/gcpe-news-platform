import express, { type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { tzCheckFor } from "@gcpe/config";
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
import { listManualReviews, manualReviewInputSchema, recordManualReview } from "../services/manual-reviews";
import { auditQuerySchema, listAudit } from "../services/audit";
import { republishAll } from "../services/republish";
import {
  DEFAULT_TIME_ZONE,
  cancelCabinetChange,
  instantToLocal,
  localToInstant,
  getOpenCabinetChange,
  previewCabinetChange,
  publishCabinetChange,
  saveCabinetChangeDraft,
  scheduleCabinetChange,
  type CabinetChangeRecord,
} from "../services/cabinet-changes";
import { checkTermWrite, createTerm, deactivateTerm, getTerm, listTerms, TermExistsError, TermRuleError, termInputSchema, upsertTerm } from "../services/terms";
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
  if (e instanceof TermExistsError) return void res.status(409).json({ error: e.message, code: "key-exists" });
  if (e instanceof TermRuleError) return void res.status(e.code === "key-taken" ? 409 : 400).json({ error: e.code });
  // drizzle wraps the pg error; a unique violation on the terms table means another create of the key won the race.
  if ((e as { cause?: { code?: string; constraint?: string } }).cause?.code === "23505" && (e as { cause?: { constraint?: string } }).cause?.constraint === "terms_kind_key")
    return void res.status(409).json({ error: "key-taken" });
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

export function apiRoutes(db: Db, subscribers: SubscriberConfig[], opts: { timeZone?: string } = {}): express.Router {
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const r = express.Router();
  const admin = requireRole("Core.Admin");

  // Any signed-in user, whatever their roles: the Hub's stale-browser time-zone warning
  // (staff-web format/timeZoneWarning.ts) must reach Calendar-only and NoD-only staff too.
  r.get(
    "/time-zone-check",
    safe(async (_req, res) => void res.json({ timeZone, tzCheck: tzCheckFor(timeZone) })),
  );

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
      const result = await createOrganization(db, input, subscribers, undefined, undefined, actorOf(req));
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
      const result = await upsertOrganization(db, input, subscribers, {
        respectStaffEdits: req.query.overwriteStaffEdits !== "true",
        checkAbbreviation: true,
        audit: actorOf(req),
      });
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
      const record = await setOrganizationHq(db, req.params.key, isHq, subscribers, actorOf(req));
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );
  const publicSchema = z.object({ isPublic: z.boolean() });
  r.put(
    "/organizations/:key/public",
    admin,
    safe<{ key: string }>(async (req, res) => {
      const { isPublic } = publicSchema.parse(req.body);
      const record = await setOrganizationPublic(db, req.params.key, isPublic, subscribers, actorOf(req));
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
      const record = await patchOrganizationProfile(db, req.params.key, orgProfilePatchSchema.parse(body), subscribers, undefined, undefined, actorOf(req));
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );
  r.post(
    "/organizations/:key/deactivate",
    admin,
    safe<{ key: string }>(async (req, res) => {
      (await deactivateOrganization(db, req.params.key, subscribers, undefined, undefined, actorOf(req))) ? res.status(204).end() : res.status(404).json({ error: "not found" });
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
      const record = await succeedOrganization(db, req.params.key, successionInputSchema.parse(req.body), subscribers, undefined, undefined, actorOf(req));
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );

  // New-government spec §5: the staged cabinet change. One change is open (draft or scheduled) at a
  // time, so these routes address "the" open change rather than an id.
  const noOpenChange = (res: Response) => void res.status(404).json({ error: "no open cabinet change" });
  // The scheduled time as the tenant's clock shows it, by this server's tzdata (NG-R15), so the Hub
  // shows the same BC time Core will publish at, whatever the browser's own tzdata says.
  const view = (c: CabinetChangeRecord) => ({ ...c, scheduledForLocal: c.scheduledFor ? instantToLocal(c.scheduledFor, timeZone) : null });
  r.get(
    "/cabinet-change",
    admin,
    safe(async (_req, res) => {
      const change = await getOpenCabinetChange(db);
      change ? res.json(view(change)) : noOpenChange(res);
    }),
  );
  const draftSchema = z.object({ operations: z.array(z.unknown()) }).strict();
  r.put(
    "/cabinet-change",
    admin,
    safe(async (req, res) => {
      const { operations } = draftSchema.parse(req.body);
      res.json(view(await saveCabinetChangeDraft(db, operations, actorOf(req).name, actorOf(req))));
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
    safe(async (req, res) => {
      const change = await getOpenCabinetChange(db);
      if (!change) return noOpenChange(res);
      const result = await publishCabinetChange(db, change.id, subscribers, { audit: actorOf(req) });
      const status = { published: 200, stale: 409, invalid: 422, "not-open": 404 }[result.result];
      res.status(status).json(result);
    }),
  );
  // NG-R15: the Hub sends the BC wall-clock time ("YYYY-MM-DDTHH:mm") and Core converts it with the
  // tenant zone; an explicit instant (`at`) is still accepted.
  const scheduleSchema = z.union([
    z
      .object({
        scheduledForLocal: z.string().refine((v) => localToInstant(v, timeZone) !== null, "Enter a real date and time."),
      })
      .strict(),
    z.object({ at: z.string().datetime({ offset: true }) }).strict(),
  ]);
  r.post(
    "/cabinet-change/schedule",
    admin,
    safe(async (req, res) => {
      const body = scheduleSchema.parse(req.body);
      const at = "at" in body ? new Date(body.at) : localToInstant(body.scheduledForLocal, timeZone)!;
      const change = await getOpenCabinetChange(db);
      if (!change) return noOpenChange(res);
      const result = await scheduleCabinetChange(db, change.id, at, undefined, actorOf(req));
      if (result.result === "scheduled") return void res.json(view(result.change));
      if (result.result === "not-open") return noOpenChange(res);
      if (result.result === "past") return void res.status(422).json({ result: "past", error: "Choose a time in the future." });
      res.status(422).json(result);
    }),
  );
  r.post(
    "/cabinet-change/cancel",
    admin,
    safe(async (req, res) => {
      const change = await getOpenCabinetChange(db);
      if (!change || !(await cancelCabinetChange(db, change.id, actorOf(req)))) return noOpenChange(res);
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
  // Add: create-only. PUT below replaces whatever is stored under the key, so it is for edits.
  r.post(
    "/terms/:kind",
    admin,
    safe<{ kind: string }>(async (req, res) => {
      const kind = parseKind(req, res);
      if (!kind) return;
      const parsed = termInputSchema.strict().parse(req.body);
      if (parsed.kind !== kind) return void res.status(400).json({ error: "body kind must match path" });
      res.status(201).json((await createTerm(db, parsed, subscribers, actorOf(req))).record);
    }),
  );
  r.put(
    "/terms/:kind/:key",
    admin,
    safe<{ kind: string; key: string }>(async (req, res) => {
      const kind = parseKind(req, res);
      if (!kind) return;
      const parsed = termInputSchema.parse(req.body);
      if (parsed.kind !== kind || parsed.key !== req.params.key) return void res.status(400).json({ error: "body kind/key must match path" });
      await checkTermWrite(db, parsed);
      const input = { ...parsed, displayName: parsed.displayName!.trim() };
      res.json((await upsertTerm(db, input, subscribers, { audit: actorOf(req) })).record);
    }),
  );
  r.post(
    "/terms/:kind/:key/deactivate",
    admin,
    safe<{ kind: string; key: string }>(async (req, res) => {
      const kind = parseKind(req, res);
      if (!kind) return;
      (await deactivateTerm(db, kind, req.params.key, subscribers, actorOf(req))) ? res.status(204).end() : res.status(404).json({ error: "not found" });
    }),
  );

  // Hub Help, "Changed since your last review": which manual page versions a Core admin has reviewed.
  r.get(
    "/manual-reviews",
    admin,
    safe(async (_req, res) => void res.json(await listManualReviews(db))),
  );
  r.post(
    "/manual-reviews",
    admin,
    safe(async (req, res) => {
      await recordManualReview(db, manualReviewInputSchema.parse(req.body), actorOf(req).name);
      res.status(201).end();
    }),
  );

  // Suite review O3: Core's admin audit trail, newest first: one user's or organization's
  // history (targetType + targetId), or Admin history's filters. Core administrators only.
  r.get(
    "/audit",
    admin,
    safe(async (req, res) => void res.json(await listAudit(db, auditQuerySchema.parse(req.query), timeZone))),
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
