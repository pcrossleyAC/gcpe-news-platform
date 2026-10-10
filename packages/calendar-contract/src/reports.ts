import { z } from "zod";
import { listQuerySchema } from "./list";

/** The four reports (spec addendum §10), as their route names. */
export const REPORT_KINDS = ["look-ahead", "exec-look-ahead", "30-60-90", "planning"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const isReportKind = (s: string): s is ReportKind => (REPORT_KINDS as readonly string[]).includes(s);

/** The list toolbar's button labels. */
export const REPORT_LABELS: Readonly<Record<ReportKind, string>> = {
  "look-ahead": "Look Ahead",
  "exec-look-ahead": "Exec Look Ahead",
  "30-60-90": "30/60/90",
  planning: "Planning",
};

/** The downloaded file's name. */
export const REPORT_FILE_NAMES: Readonly<Record<ReportKind, string>> = {
  "look-ahead": "LookAhead.pdf",
  "exec-look-ahead": "ExecLookAhead.pdf",
  "30-60-90": "30-60-90.pdf",
  planning: "PlanningReport.pdf",
};

/** `POST /calendar/api/reports/:report`'s body: the list's current query, as the Excel export takes it. */
export const reportStartSchema = z.object({ q: listQuerySchema }).strict();

/** A report job's id: 16 random bytes, base64url. */
export const reportJobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "not a report id");

export const REPORT_JOB_STATUSES = ["running", "ready", "failed"] as const;
export type ReportJobStatus = (typeof REPORT_JOB_STATUSES)[number];

/** What the report routes answer about a job. Only the user who started it ever sees it. */
export interface ReportJobView {
  id: string;
  report: ReportKind;
  status: ReportJobStatus;
  /** Why it failed, in words for staff; null unless failed. */
  error: string | null;
}
