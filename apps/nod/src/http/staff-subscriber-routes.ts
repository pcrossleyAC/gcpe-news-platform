import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { subscribers } from "../db/schema";
import { addSubscriber, SubscriberExistsError } from "../subscribers";
import { normaliseEmail, subscriberEmailSchema } from "../subscribe/info";
import {
  BULK_ACTIONS, BULK_MAX, bulkAction, changeEmail, deleteSubscriber, EmailTakenError, MediaHubManagedError, setStatus,
  StaffPreferencesError, SubscriberNotFoundError, SubscriberStateError, updatePreferences,
} from "../staff-subscribers/actions";
import { getSubscriberDetail, listHistory, listOptions, searchSubscribers, STATUS_FILTERS } from "../staff-subscribers/read";
import { privateErrorsWith } from "./private-errors";

/** Spec §8: Viewer reads the Subscribers section; Editor and Admin also change it. */
export const NOD_READ_ROLES = ["NoD.Viewer", "NoD.Editor", "NoD.Admin"] as const;
export const NOD_WRITE_ROLES = ["NoD.Editor", "NoD.Admin"] as const;

/** '*' is "all" in addSubscriberSchema; otherwise '<category>:<key>' in a public category. */
export const listKeySchema = z
  .string()
  .regex(/^(ministries|sectors|themes|tags|emergency):.+$/i, "must be '<kind>:<key>' with kind in ministries|sectors|themes|tags|emergency");

/** Timing is optional so the original admin/service add body (`{ email, lists }`) still means
 * what it always did: as-it-happens only. */
export const addSubscriberSchema = z
  .object({
    email: subscriberEmailSchema,
    lists: z.union([z.literal("all"), z.array(listKeySchema)]),
    asItHappens: z.boolean().optional(),
    digest: z.boolean().optional(),
  })
  .refine((b) => (b.asItHappens ?? true) || b.digest === true, { message: "Choose As It Happens, Daily Digest, or both.", path: ["asItHappens"] });

const prefsBody = z.object({ asItHappens: z.boolean(), digest: z.boolean(), allNews: z.boolean(), listKeys: z.array(z.string().max(200)).max(500) });
const statusBody = z.object({ status: z.enum(["active", "disabled"]) });
const emailBody = z.object({ email: subscriberEmailSchema });
const bulkBody = z.object({ action: z.enum(BULK_ACTIONS), ids: z.array(z.string().uuid()).min(1).max(BULK_MAX) });

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

/** Maps this router's domain errors to responses; false for anything else. */
function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof SubscriberNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof SubscriberStateError) return void res.status(409).json({ error: "status", status: e.status }), true;
  if (e instanceof EmailTakenError) return void res.status(409).json({ error: "email-taken", id: e.id }), true;
  if (e instanceof MediaHubManagedError) return void res.status(409).json({ error: "media-hub-managed" }), true;
  if (e instanceof StaffPreferencesError) return void res.status(400).json({ error: e.message }), true;
  return false;
}

/** Every handler here binds addresses or search terms (see private-errors.ts). */
export const privateErrors = privateErrorsWith(mapError, "staff subscriber request");

const notFound = (res: Response) => void res.status(404).json({ error: "not found" });

export function staffSubscriberRoutes(db: Db): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);
  const write = requireAnyRole(...NOD_WRITE_ROLES);

  /** Runs `h` with the `:id` path parameter once it's a uuid; anything else is 404, the same as
   * an id that names no subscriber. */
  const withId = (h: (id: string, req: Request<{ id: string }>, res: Response) => Promise<void>) =>
    privateErrors<{ id: string }>(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return notFound(res);
      await h(id.data, req, res);
    });

  // A search term is usually an email address, and a GET's query string is recorded by every
  // reverse proxy in front of this (SiteGround nginx, the OpenShift router) and by browsers —
  // so the term travels in a POST body instead, never in the URL. Literal paths like this and
  // `/subscribers/bulk` are registered ahead of `/subscribers/:id` so a segment of "search" or
  // "bulk" is never mistaken for an id.
  r.post("/subscribers/search", read, privateErrors(async (req, res) => {
    res.json(await searchSubscribers(db, searchBody.parse(req.body)));
  }));

  r.get("/subscriber-list-options", read, privateErrors(async (_req, res) => {
    res.json(await listOptions(db));
  }));

  /** Adds a subscriber, active at once with no verification email (C51). Also the original
   * admin/service add, which keeps working: same path, body and response, with timing optional. */
  r.post("/subscribers", write, privateErrors(async (req, res) => {
    const parsed = addSubscriberSchema.parse(req.body);
    try {
      res.status(201).json(await addSubscriber(db, parsed, actorOf(req).name));
    } catch (e) {
      if (!(e instanceof SubscriberExistsError)) throw e;
      const [row] = await db.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${normaliseEmail(parsed.email)}`);
      res.status(409).json({ error: "subscriber exists", id: row?.id ?? null });
    }
  }));

  r.post("/subscribers/bulk", write, privateErrors(async (req, res) => {
    const { action, ids } = bulkBody.parse(req.body);
    res.json(await bulkAction(db, ids, action, actorOf(req).name));
  }));

  r.get("/subscribers/:id", read, withId(async (id, _req, res) => {
    const detail = await getSubscriberDetail(db, id);
    if (!detail) return notFound(res);
    res.json(detail);
  }));

  r.get("/subscribers/:id/history", read, withId(async (id, _req, res) => {
    const page = await listHistory(db, id);
    if (!page) return notFound(res);
    res.json(page);
  }));

  r.put("/subscribers/:id/preferences", write, withId(async (id, req, res) => {
    await updatePreferences(db, id, prefsBody.parse(req.body), actorOf(req).name);
    res.json({ ok: true });
  }));

  r.post("/subscribers/:id/status", write, withId(async (id, req, res) => {
    res.json(await setStatus(db, id, statusBody.parse(req.body).status, actorOf(req).name));
  }));

  r.post("/subscribers/:id/email", write, withId(async (id, req, res) => {
    res.json(await changeEmail(db, id, emailBody.parse(req.body).email, actorOf(req).name));
  }));

  r.delete("/subscribers/:id", write, withId(async (id, req, res) => {
    res.json(await deleteSubscriber(db, id, actorOf(req).name));
  }));

  return r;
}
