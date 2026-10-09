import { Router, type Request } from "express";
import { z } from "zod";
import { LIST_QUERY_MAX_CHARS, bcDateSchema, checkCalendarRange, listPreferencesSchema, listQuerySchema } from "@gcpe/calendar-contract";
import { calendarRange } from "../list/calendar-range";
import { exportWorkbook } from "../list/export";
import { listOptions } from "../list/options";
import { listPage } from "../list/page";
import { readPreferences, writePreferences } from "../list/preferences";
import { unwatchActivity, watchActivity } from "../list/watch";
import { XLSX_CONTENT_TYPE } from "../list/xlsx";
import { idOf } from "./activity-routes";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** The list query, as JSON in `q` (spec addendum §8.1's filter model). Bad JSON is a 400 like any other bad value. */
export const listQueryParam = z
  .string()
  .max(LIST_QUERY_MAX_CHARS)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "q must be JSON" });
      return z.NEVER;
    }
  })
  .pipe(listQuerySchema);
const offset = z.string().regex(/^\d{1,7}$/, "offset is a whole number").transform(Number);
const pageParams = z.object({ q: listQueryParam, offset: offset.optional() }).strict();
const emptyBody = z.object({}).strict();
const rangeParams = z
  .object({ q: listQueryParam, start: bcDateSchema, end: bcDateSchema })
  .strict()
  .superRefine((p, ctx) => {
    const problem = checkCalendarRange(p.start, p.end);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["end"] });
  });
const exportParams = z.object({ q: listQueryParam }).strict();

/** The activity list (spec addendum §8.1). Every reader filters inside visibleSql. */
export function listRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/list", runList(async (req, res) => {
    const p = pageParams.parse(req.query);
    res.json(await listPage(deps, req.calendar!, p.q, p.offset ?? 0));
  }));
  r.get("/list/calendar", runList(async (req, res) => {
    const p = rangeParams.parse(req.query);
    res.json(await calendarRange(deps, req.calendar!, p.q, p.start, p.end));
  }));
  r.get("/list/export.xlsx", runList(async (req, res) => {
    const body = await exportWorkbook(deps, req.calendar!, exportParams.parse(req.query).q);
    res.set({
      "Content-Type": XLSX_CONTENT_TYPE,
      "Content-Disposition": 'attachment; filename="BCGovernmentActivities.xlsx"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.send(body);
  }));
  r.get("/list/options", runList(async (req, res) => void res.json(await listOptions(deps.db, req.calendar!))));
  r.get("/list/preferences", runList(async (req, res) => void res.json(await readPreferences(deps.db, req.calendar!.userId))));
  r.put("/list/preferences", runList(async (req, res) => {
    res.json(await writePreferences(deps.db, req.calendar!.userId, listPreferencesSchema.parse(req.body)));
  }));
  r.put("/activities/:id/watch", runList(async (req, res) => {
    emptyBody.parse(req.body ?? {});
    await watchActivity(deps.db, req.calendar!, idOf(req as Request<{ id: string }>));
    res.status(204).end();
  }));
  r.delete("/activities/:id/watch", runList(async (req, res) => {
    emptyBody.parse(req.body ?? {});
    await unwatchActivity(deps.db, req.calendar!, idOf(req as Request<{ id: string }>));
    res.status(204).end();
  }));
  return r;
}
