import { Router } from "express";
import { z } from "zod";
import { dbNow } from "../time";
import { successionCounts } from "../succession";
import type { ApiDeps } from "./routes";

/**
 * What a succession would move in the Calendar (new-government spec §4), for Core's confirm
 * screen. Mounted after requireBearer and requireRole("Core.Admin"), ahead of /api's Calendar-actor
 * gate: the caller is a Core administrator, not necessarily a Calendar user.
 */
const isoDateTime = z.string().datetime({ offset: true });

export function successionRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/:key/preview", async (req, res, next) => {
    try {
      // Optional ?at= previews a later effective time; the default is now, as Core applies it.
      // ISO 8601 with an offset (or Z) only: `new Date()` alone would take "1" or a bare date.
      if (req.query.at !== undefined && !isoDateTime.safeParse(req.query.at).success) return void res.status(400).json({ error: "at must be an ISO date-time with an offset" });
      const asked = typeof req.query.at === "string" ? new Date(req.query.at) : null;
      const at = asked ?? (await dbNow(deps.db, deps.now));
      res.json(await successionCounts(deps.db, req.params.key!, at, deps.rules.timeZone));
    } catch (e) {
      next(e);
    }
  });
  return r;
}
