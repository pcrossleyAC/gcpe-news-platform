import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import {
  CALENDAR_ONLY_MESSAGES,
  calendarAccessSchema,
  CalendarGrantRefusedError,
  CalendarOnlyError,
  linkCalendarUser,
  listCalendarAccess,
  REFUSAL_MESSAGES,
  setCalendarAccess,
  setCalendarUserActive,
  UnknownOrganizationError,
} from "../services/calendar-access";
import { linkUserSchema, UserAlreadyHasEmailError, UserExistsError, UserNeedsEmailError, UserNotFoundError } from "../services/users";
import { isSelf, SelfLockoutError } from "./self";

/** Who may open these routes at all; checkCalendarGrant then decides each change (C125, C140). */
export const CALENDAR_ACCESS_ROLES = ["Core.Admin", "Calendar.Administrator", "Calendar.SysAdmin"] as const;

type IdParams = { id: string };
const run = <P>(h: (req: Request<P>, res: Response) => Promise<void>) => (req: Request<P>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof UserNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof CalendarGrantRefusedError) return void res.status(403).json({ error: REFUSAL_MESSAGES[e.reason], reason: e.reason });
    if (e instanceof UnknownOrganizationError) return void res.status(400).json({ error: "unknown or inactive ministry", keys: e.keys });
    if (e instanceof CalendarOnlyError) return void res.status(403).json({ error: CALENDAR_ONLY_MESSAGES[e.reason], reason: e.reason });
    if (e instanceof SelfLockoutError) return void res.status(409).json({ error: "you can't deactivate yourself" });
    if (e instanceof UserNeedsEmailError) return void res.status(409).json({ error: "set an email before activating this user" });
    if (e instanceof UserAlreadyHasEmailError) return void res.status(409).json({ error: "this user already has an email" });
    if (e instanceof UserExistsError) return void res.status(409).json({ error: "a user with that email already exists" });
    next(e);
  });

const activeSchema = z.object({ isActive: z.boolean() }).strict();
const linkSchema = linkUserSchema.strict();

/**
 * Activating, deactivating and linking change who can sign in (and, once Entra sign-in matches by
 * email, which person an account belongs to), so they take a signed-in person. Every bearer token
 * is refused here, a Core.Admin one included: automation keeps Core's own /api/users routes.
 */
const sessionOnly: RequestHandler = (req, res, next) => {
  if (req.auth?.claims.via !== "session") return void res.status(403).json({ error: "only a signed-in person can change a user's account here" });
  next();
};

/** Calendar roles and ministries, and the account of a Calendar-only user (spec addendum §4, §8.5, Q55). Mounted behind requireAnyRole(...CALENDAR_ACCESS_ROLES). */
export function calendarAccessRouter(db: Db, subscribers: SubscriberConfig[]): Router {
  const r = Router();
  r.get("/", run(async (_req, res) => void res.json(await listCalendarAccess(db))));
  r.put(
    "/:id",
    run<IdParams>(async (req, res) => {
      const input = calendarAccessSchema.parse(req.body);
      // The actor is the verified caller, whose roles Core has already re-derived for a session.
      res.json(await setCalendarAccess(db, { id: req.auth!.subject, roles: req.auth!.roles }, req.params.id, input, subscribers));
    }),
  );
  r.put(
    "/:id/active",
    sessionOnly,
    run<IdParams>(async (req, res) => {
      const { isActive } = activeSchema.parse(req.body);
      if (!isActive && isSelf(req)) throw new SelfLockoutError();
      res.json(await setCalendarUserActive(db, { id: req.auth!.subject, roles: req.auth!.roles }, req.params.id, isActive, subscribers));
    }),
  );
  r.post(
    "/:id/link",
    sessionOnly,
    run<IdParams>(async (req, res) => {
      const { email } = linkSchema.parse(req.body);
      res.json(await linkCalendarUser(db, { id: req.auth!.subject, roles: req.auth!.roles }, req.params.id, email, subscribers));
    }),
  );
  return r;
}
