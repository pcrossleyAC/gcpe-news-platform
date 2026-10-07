import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { MediaHubError, type MediaHubClient } from "../media-hub/client";
import { getMediaSyncStatus, resolveMediaMember, runMediaSync } from "../media-hub/sync";
import { addMediaMember, listMediaLists, listMediaMembers, listMediaOptOuts, MediaListNotFoundError, OptedOutError, removeMediaMember } from "../media-members";
import { emailAddressSchema } from "../subscribe/info";
import { privateErrorsWith } from "./private-errors";
import { NOD_READ_ROLES, NOD_WRITE_ROLES } from "./staff-subscriber-routes";

export const addMediaMemberSchema = z.union([
  z.object({ email: emailAddressSchema, confirmOptOut: z.boolean().optional() }),
  z.object({ mediaHubContactId: z.number().int(), emailRef: z.string().min(1), confirmOptOut: z.boolean().optional() }),
]);

export const resolveMediaMemberSchema = z.object({ emailRef: z.string().min(1).optional() });

/** Staff choose a query and page, never a page size. */
export const MEDIA_HUB_SEARCH_PAGE_SIZE = 25;

const searchBody = z.object({
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const uuid = z.string().uuid();
const contactId = z.string().regex(/^\d{1,9}$/).transform(Number);

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof MediaListNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof OptedOutError) return void res.status(409).json({ error: "opted-out", at: e.at.toISOString() }), true;
  if (e instanceof MediaHubError) {
    // Kind and status only: the client's own messages are address-free, but a network error's
    // text comes from the platform and is not ours to vouch for.
    console.error("[nod] Media Hub call failed", e.kind, e.status ?? "");
    res.status(502).json({ error: "media hub unavailable" });
    return true;
  }
  return false;
}

/** Member adds bind addresses, and search binds a term (see private-errors.ts). */
const privateErrors = privateErrorsWith(mapError, "staff media-list request");
const notFound = (res: Response) => void res.status(404).json({ error: "not found" });
const noHub = (res: Response) => void res.status(503).json({ error: "media hub not configured" });

/**
 * Media lists for the staff section (spec §8): NoD Viewers read lists, members, opt-outs and
 * the sync status; NoD Editors and Admins change membership, search Media Hub, run the sync
 * and resolve flags. List names and keys come from NRMS (C47) and aren't edited here.
 */
export function staffMediaRoutes(db: Db, mediaHub: MediaHubClient | null): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);
  const write = requireAnyRole(...NOD_WRITE_ROLES);

  r.get("/media-lists", read, privateErrors(async (_req, res) => {
    res.json(await listMediaLists(db));
  }));

  r.get("/media-lists/:key/members", read, privateErrors<{ key: string }>(async (req, res) => {
    res.json(await listMediaMembers(db, req.params.key));
  }));

  r.get("/media-lists/:key/opted-out", read, privateErrors<{ key: string }>(async (req, res) => {
    res.json(await listMediaOptOuts(db, req.params.key));
  }));

  r.post("/media-lists/:key/members", write, privateErrors<{ key: string }>(async (req, res) => {
    const parsed = addMediaMemberSchema.parse(req.body);
    const actor = actorOf(req).name;
    if ("mediaHubContactId" in parsed) {
      if (!mediaHub) return noHub(res);
      const contact = await mediaHub.get(parsed.mediaHubContactId);
      const email = contact?.deletedAt ? undefined : contact?.emails.find((e) => e.ref === parsed.emailRef);
      if (!contact || contact.deletedAt || !email) return notFound(res);
      // The contract doesn't require a valid address (contract.ts); it's checked here, with the
      // same schema and response as a manual add's bad email.
      const address = emailAddressSchema.safeParse(email.address);
      if (!address.success) return void res.status(400).json({ error: "invalid request", issues: address.error.issues });
      const { subscriberId, created } = await addMediaMember(
        db,
        req.params.key,
        { email: address.data, source: "media-hub", mediaHubContactId: parsed.mediaHubContactId, mediaHubEmailRef: parsed.emailRef, confirmOptOut: parsed.confirmOptOut },
        actor,
      );
      return void res.status(created ? 201 : 200).json({ subscriberId, created });
    }
    const { subscriberId, created } = await addMediaMember(db, req.params.key, { email: parsed.email, source: "manual-media", confirmOptOut: parsed.confirmOptOut }, actor);
    res.status(created ? 201 : 200).json({ subscriberId, created });
  }));

  r.delete("/media-lists/:key/members/:subscriberId", write, privateErrors<{ key: string; subscriberId: string }>(async (req, res) => {
    if (!uuid.safeParse(req.params.subscriberId).success) return notFound(res);
    await removeMediaMember(db, req.params.key, req.params.subscriberId, actorOf(req).name);
    res.status(204).end();
  }));

  // The term is usually a name or an address, and a URL's query string lands in every proxy's
  // access log and in browser history, so it travels in the body (as subscriber search does).
  r.post("/media-hub/contacts/search", write, privateErrors(async (req, res) => {
    if (!mediaHub) return noHub(res);
    const { q, page } = searchBody.parse(req.body ?? {});
    res.json(await mediaHub.search(q, page, MEDIA_HUB_SEARCH_PAGE_SIZE));
  }));

  // One contact's current emails, for the resolve dialog.
  r.get("/media-hub/contacts/:id", write, privateErrors<{ id: string }>(async (req, res) => {
    const id = contactId.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    if (!mediaHub) return noHub(res);
    const contact = await mediaHub.get(id.data);
    if (!contact || contact.deletedAt) return notFound(res);
    res.json(contact);
  }));

  r.get("/media-hub/sync", read, privateErrors(async (_req, res) => {
    res.json(await getMediaSyncStatus(db));
  }));

  r.post("/media-hub/sync", write, privateErrors(async (_req, res) => {
    if (!mediaHub) return noHub(res);
    const outcome = await runMediaSync(db, mediaHub);
    if (outcome === "busy") return void res.status(409).json({ error: "sync in progress" });
    res.json(outcome);
  }));

  r.post("/media-members/:subscriberId/resolve", write, privateErrors<{ subscriberId: string }>(async (req, res) => {
    if (!uuid.safeParse(req.params.subscriberId).success) return notFound(res);
    const parsed = resolveMediaMemberSchema.parse(req.body ?? {});
    const outcome = await resolveMediaMember(db, mediaHub, req.params.subscriberId, parsed.emailRef, actorOf(req).name);
    if (outcome === "not-found" || outcome === "ref-not-found") return notFound(res);
    if (outcome === "media-hub-unavailable") return noHub(res);
    if (outcome === "invalid-email") return void res.status(400).json({ error: "invalid email" });
    if (outcome === "email-taken") return void res.status(409).json({ error: "email-taken" });
    if (outcome === "conflict") return void res.status(409).json({ error: "changed, retry" });
    res.status(200).json({ ok: true });
  }));

  return r;
}
