import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { requireLevel } from "../actor";
import { CalendarUserNotFoundError, getCalendarUser, listCalendarUsers, NotUsersMinistryError, openActivitiesOf, profileSchema, rankSchema, saveProfile, setCommContactRank } from "../users";
import type { ApiDeps } from "./routes";

type Params = { id: string; ministryKey?: string };
const run = (h: (req: Request<Params>, res: Response) => Promise<void>) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof CalendarUserNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof NotUsersMinistryError) {
      return void res.status(409).json({ error: `${e.ministryKey} isn't one of this user's ministries in the Calendar yet: save their ministries first; the Calendar picks them up within a minute` });
    }
    next(e);
  });

/** Calendar users (spec addendum §8.5): Administrator and above. Role, ministries, active and link are Core's. */
export function userRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.use("/users", requireLevel("Calendar.Administrator"));
  r.get("/users", run(async (req, res) => {
    res.json(await listCalendarUsers(deps.db, { inactive: req.query.inactive === "1", noAccess: req.query.noAccess === "1" }));
  }));
  r.get("/users/:id/open-activities", run(async (req, res) => void res.json(await openActivitiesOf(deps, req.calendar!, req.params.id))));
  r.get("/users/:id", run(async (req, res) => void res.json(await getCalendarUser(deps.db, req.params.id))));
  r.put("/users/:id/profile", run(async (req, res) => void res.json(await saveProfile(deps.db, req.params.id, profileSchema.parse(req.body)))));
  r.put("/users/:id/comm-contacts/:ministryKey", run(async (req, res) => {
    const { rank } = rankSchema.parse(req.body);
    res.json(await setCommContactRank(deps.db, req.params.id, req.params.ministryKey!, rank));
  }));
  return r;
}
