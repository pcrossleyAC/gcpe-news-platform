import { Router } from "express";
import { z, ZodError } from "zod";
import { safeString } from "@gcpe/calendar-contract";
import { requireLevel } from "../actor";
import { listDeadLetters, REPLACED_MESSAGE, retryDeadLetter } from "../dead-letters";
import type { ApiDeps } from "./routes";

const retrySchema = z.object({ eventId: z.string().uuid(), subscriber: safeString().min(1).max(100) }).strict();

/** The dead-letter page's API (spec addendum §5.1): System Administrators only. */
export function deadLetterRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.use("/dead-letters", requireLevel("Calendar.SysAdmin"));
  r.get("/dead-letters", async (req, res, next) => {
    try {
      res.json(await listDeadLetters(deps.db, deps.rules.timeZone, req.calendar!));
    } catch (e) {
      next(e);
    }
  });
  r.post("/dead-letters/retry", async (req, res, next) => {
    try {
      const b = retrySchema.parse(req.body);
      const outcome = await retryDeadLetter(deps.db, b.eventId, b.subscriber);
      if (outcome === "not-found") return void res.status(404).json({ error: "not found" });
      if (outcome === "replaced") return void res.status(409).json({ error: REPLACED_MESSAGE });
      res.status(204).end();
    } catch (e) {
      if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
      next(e);
    }
  });
  return r;
}
