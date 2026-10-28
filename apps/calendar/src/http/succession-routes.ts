import { Router } from "express";
import { dbNow } from "../time";
import { successionCounts } from "../succession";
import type { ApiDeps } from "./routes";

/**
 * What a succession would move in the Calendar (new-government spec §4), for Core's confirm
 * screen. Mounted after requireBearer and requireRole("Core.Admin"), ahead of /api's Calendar-actor
 * gate: the caller is a Core administrator, not necessarily a Calendar user.
 */
export function successionRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/:key/preview", async (req, res, next) => {
    try {
      // Optional ?at= previews a later effective time; the default is now, as Core applies it.
      const asked = typeof req.query.at === "string" ? new Date(req.query.at) : null;
      if (asked && Number.isNaN(asked.getTime())) return void res.status(400).json({ error: "at must be a date-time" });
      const at = asked ?? (await dbNow(deps.db, deps.now));
      res.json(await successionCounts(deps.db, req.params.key!, at, deps.rules.timeZone));
    } catch (e) {
      next(e);
    }
  });
  return r;
}
