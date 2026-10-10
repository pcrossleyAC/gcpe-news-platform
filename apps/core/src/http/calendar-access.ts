import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { calendarAccessSchema, CalendarGrantRefusedError, listCalendarAccess, REFUSAL_MESSAGES, setCalendarAccess, UnknownOrganizationError } from "../services/calendar-access";
import { UserNotFoundError } from "../services/users";

/** Who may open these routes at all; checkCalendarGrant then decides each change (C125, C140). */
export const CALENDAR_ACCESS_ROLES = ["Core.Admin", "Calendar.Administrator", "Calendar.SysAdmin"] as const;

type IdParams = { id: string };
const run = <P>(h: (req: Request<P>, res: Response) => Promise<void>) => (req: Request<P>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof UserNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof CalendarGrantRefusedError) return void res.status(403).json({ error: REFUSAL_MESSAGES[e.reason], reason: e.reason });
    if (e instanceof UnknownOrganizationError) return void res.status(400).json({ error: "unknown or inactive ministry", keys: e.keys });
    next(e);
  });

/** Calendar roles and ministries (spec addendum §4, §8.5). Mounted behind requireAnyRole(...CALENDAR_ACCESS_ROLES). */
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
  return r;
}
