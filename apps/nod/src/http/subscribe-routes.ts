import express, { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { requireAnyRole, NOD_SUBSCRIBE_API_ROLE } from "@gcpe/auth";
import { publicListItems } from "../lists";
import { PreferencesError, subscriberInfoSchema } from "../subscribe/info";
import { checkToken, confirm, requestManageLink, safeErrorLabel, subscribe, unsubscribe, update, type JourneyDeps } from "../subscribe/journeys";

type H = (req: Request, res: Response) => Promise<void>;
// Anything other than a validation error is never passed to `next(e)` / jsonErrorHandler here:
// a journey error can be a DrizzleQueryError, whose message is "Failed query: <sql>\nparams:
// <params>" — every query in this module binds an email address, so jsonErrorHandler logging the
// whole error would put addresses in the logs (I4, reviewer finding). Log a fixed string plus
// safeErrorLabel(e) instead, which never carries a bound value.
const run = (h: H) => (req: Request, res: Response) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof PreferencesError) return void res.status(400).json({ error: e.message });
    console.error("[nod] subscribe route failed", safeErrorLabel(e));
    res.status(500).json({ error: "internal error" });
  });
const param = (req: Request, name: string) => String(req.params[name] ?? "");

/** The legacy public Subscribe API (spec §4), reached through the News API proxy. */
export function subscribeApiRoutes(deps: JourneyDeps): Router {
  const r = Router();
  r.use(requireAnyRole(NOD_SUBSCRIBE_API_ROLE, "NoD.Admin"));
  r.get("/SubscriptionItems/:categoryKey", run(async (req, res) => void res.json(await publicListItems(deps.db, param(req, "categoryKey").toLowerCase()))));
  r.post("/CreateNewsOnDemandEmailSubscriptionWithPreferences", run(async (req, res) => {
    await subscribe(deps, subscriberInfoSchema.parse(req.body));
    res.status(204).end();
  }));
  r.get("/ConfirmUpdateCreateSubscription/:tokenGuid", run(async (req, res) => void res.json(await confirm(deps, param(req, "tokenGuid")))));
  r.post("/UpdateNewsOnDemandEmailSubscriptionWithPreferences/:tokenGuid", run(async (req, res) => {
    const outcome = await update(deps, param(req, "tokenGuid"), subscriberInfoSchema.parse(req.body));
    if (outcome === "invalid") return void res.status(404).json({ error: "This link is not valid or has expired." });
    res.status(204).end();
  }));
  r.get("/ManageNewsOnDemandEmailSubscription/:emailAddress", run(async (req, res) => {
    const parsed = subscriberInfoSchema.shape.emailAddress.safeParse(param(req, "emailAddress"));
    if (parsed.success) await requestManageLink(deps, parsed.data);
    res.status(204).end();
  }));
  r.get("/CheckEmailActivationToken/:tokenGuid", run(async (req, res) => void res.json(await checkToken(deps, param(req, "tokenGuid")))));
  r.get("/UnsubscribeSubscriber/:tokenGuid", run(async (req, res) => void res.json(await unsubscribe(deps, param(req, "tokenGuid")))));
  r.post("/OneClickUnsubscribe/:tokenGuid", express.urlencoded({ extended: false, limit: "1kb" }), run(async (req, res) => void res.json(await unsubscribe(deps, param(req, "tokenGuid")))));
  return r;
}
