import type { ListQuery, ReportKind } from "@gcpe/calendar-contract";
import type { ReportData } from "./data";
import { lookAheadDays, lookAheadDoc, lookAheadRange } from "./look-ahead";
import type { ReportDoc } from "./model";
import { planningDoc } from "./planning";
import { thirtySixtyNinetyDoc, thirtySixtyNinetyMonths } from "./thirty-sixty-ninety";

/** Refuses (ReportTooLargeError) a range longer than the report allows, from the query alone, before anything is read or built. */
export function checkReportRange(kind: ReportKind, q: ListQuery, today: string, timeZone: string): void {
  if (kind === "look-ahead" || kind === "exec-look-ahead") lookAheadDays(lookAheadRange(q, today, timeZone, kind === "exec-look-ahead"));
  else if (kind === "30-60-90") thirtySixtyNinetyMonths(q, today);
}

/**
 * One report's document from what it read. `origin` is the staff app's "https://host", for each
 * row's link. A Look Ahead past `maxRows` table rows is refused before any row is drawn.
 */
export function buildReport(kind: ReportKind, data: ReportData, origin: string | null, o: { maxRows?: number } = {}): ReportDoc {
  const { scope, rows, q, now } = data;
  const c = { rules: scope.rules, isHq: scope.actor.isHq, now, today: scope.today, origin, rows, q };
  switch (kind) {
    case "look-ahead":
      return lookAheadDoc({ ...c, consultationsKeys: scope.consultationsKeys }, { detailed: false, ...o });
    case "exec-look-ahead":
      return lookAheadDoc({ ...c, consultationsKeys: scope.consultationsKeys }, { detailed: true, ...o });
    case "30-60-90":
      return thirtySixtyNinetyDoc(c);
    case "planning":
      return planningDoc(c);
  }
}
