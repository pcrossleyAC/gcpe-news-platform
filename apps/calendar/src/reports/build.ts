import type { ReportKind } from "@gcpe/calendar-contract";
import type { ReportData } from "./data";
import { lookAheadDoc } from "./look-ahead";
import type { ReportDoc } from "./model";
import { planningDoc } from "./planning";
import { thirtySixtyNinetyDoc } from "./thirty-sixty-ninety";

/** One report's document from what it read. `origin` is the staff app's "https://host", for each row's link. */
export function buildReport(kind: ReportKind, data: ReportData, origin: string | null): ReportDoc {
  const { scope, rows, q, now } = data;
  const c = { rules: scope.rules, isHq: scope.actor.isHq, now, today: scope.today, origin, rows, q };
  switch (kind) {
    case "look-ahead":
      return lookAheadDoc({ ...c, consultationsKeys: scope.consultationsKeys }, { detailed: false });
    case "exec-look-ahead":
      return lookAheadDoc({ ...c, consultationsKeys: scope.consultationsKeys }, { detailed: true });
    case "30-60-90":
      return thirtySixtyNinetyDoc(c);
    case "planning":
      return planningDoc(c);
  }
}
