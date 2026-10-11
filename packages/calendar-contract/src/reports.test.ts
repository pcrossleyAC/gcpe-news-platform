import { describe, expect, it } from "vitest";
import { DEFAULT_LIST_QUERY } from "./list";
import { REPORT_FILE_NAMES, REPORT_KINDS, isReportKind, reportJobIdSchema, reportStartSchema } from "./reports";

describe("the reports' contract (spec addendum §10)", () => {
  it("names legacy's four reports, each with a file name", () => {
    expect(REPORT_KINDS).toEqual(["look-ahead", "exec-look-ahead", "30-60-90", "planning"]);
    expect(Object.keys(REPORT_FILE_NAMES)).toEqual([...REPORT_KINDS]);
    expect(isReportKind("planning")).toBe(true);
    expect(isReportKind("word")).toBe(false);
  });

  it("starts from the list's own query, defaults filled in, and nothing else", () => {
    expect(reportStartSchema.parse({ q: {} })).toEqual({ q: DEFAULT_LIST_QUERY });
    expect(reportStartSchema.safeParse({}).success).toBe(false);
    expect(reportStartSchema.safeParse({ q: {}, format: "docx" }).success).toBe(false);
    expect(reportStartSchema.safeParse({ q: { filter: { from: "2026-02-30" } } }).success).toBe(false);
  });

  it("a job id is 22 base64url characters", () => {
    expect(reportJobIdSchema.safeParse("AbCdEfGhIjKlMnOpQrSt_-").success).toBe(true);
    for (const bad of ["", "short", "AbCdEfGhIjKlMnOpQrSt_-x", "AbCdEfGhIjKlMnOpQrSt/+", "../../../../etc/passwd"]) expect(reportJobIdSchema.safeParse(bad).success, bad).toBe(false);
  });
});
