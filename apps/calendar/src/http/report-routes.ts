import { Router, type Request } from "express";
import { REPORT_FILE_NAMES, isReportKind, reportJobIdSchema, reportStartSchema } from "@gcpe/calendar-contract";
import { ActivityForbiddenError, ActivityNotFoundError } from "../activities/errors";
import { can } from "../capabilities";
import { buildReport, checkReportRange } from "../reports/build";
import { reportData, ReportTooLargeError } from "../reports/data";
import { ReportJobNotFoundError, ReportsUnavailableError } from "../reports/jobs";
import { rowCountOf } from "../reports/model";
import { todayOf } from "../list/query";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** The most table rows one report draws: 4,800 took 7 s and a 193 MB heap on boxs.ca (2026-10-10). */
export const REPORT_ROW_LIMIT = 5000;

/** The staff app's origin for each row's link: this request's own scheme and host, when they look like one. */
function originOf(req: Request): string | null {
  const host = req.get("host") ?? "";
  return (req.protocol === "https" || req.protocol === "http") && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) ? `${req.protocol}://${host}` : null;
}

const jobIdOf = (req: Request): string => {
  const id = reportJobIdSchema.safeParse(req.params.id);
  if (!id.success) throw new ReportJobNotFoundError();
  return id.data;
};

/**
 * The reports (spec addendum §10): POST starts one from the list's query and answers 201 once its
 * PDF is ready, or 202 if it is still being prepared after a short wait; GET polls it; GET .../pdf
 * downloads it. Only the user who started a report can see it.
 */
export function reportRoutes(deps: ApiDeps): Router {
  const r = Router();
  const service = () => {
    if (!deps.reports) throw new ReportsUnavailableError();
    return deps.reports;
  };
  r.post("/reports/:report", runList(async (req, res) => {
    const report = String(req.params.report);
    if (!isReportKind(report)) throw new ActivityNotFoundError();
    const actor = req.calendar!;
    if (!can.runReport(actor, report)) throw new ActivityForbiddenError("The Exec Look Ahead is for HQ Administrators");
    const { q } = reportStartSchema.parse(req.body ?? {});
    const { jobs, inlineWaitMs } = service();
    // The cheap refusals first, before anything is read or built: a busy queue or user, then a range too long.
    jobs.assertCanStart(actor.userId);
    checkReportRange(report, q, await todayOf(deps.db, deps), deps.rules.timeZone);
    const doc = buildReport(report, await reportData(deps, actor, q), originOf(req), { maxRows: REPORT_ROW_LIMIT });
    if (rowCountOf(doc) > REPORT_ROW_LIMIT) throw new ReportTooLargeError("rows to print");
    const started = jobs.start(actor.userId, report, doc);
    const view = await jobs.settle(actor.userId, started.id, inlineWaitMs);
    res.status(view.status === "running" ? 202 : 201).json(view);
  }));
  r.get("/reports/jobs/:id", runList(async (req, res) => {
    const actor = req.calendar!;
    const view = service().jobs.view(actor.userId, jobIdOf(req));
    // As the download: a role taken away since the report started takes the report with it.
    if (!can.runReport(actor, view.report)) throw new ReportJobNotFoundError();
    res.json(view);
  }));
  r.get("/reports/jobs/:id/pdf", runList(async (req, res) => {
    const actor = req.calendar!;
    const { report, bytes } = service().jobs.pdf(actor.userId, jobIdOf(req));
    // A role taken away since the report started takes the report with it.
    if (!can.runReport(actor, report)) throw new ReportJobNotFoundError();
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${REPORT_FILE_NAMES[report]}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.send(Buffer.from(bytes));
  }));
  return r;
}
