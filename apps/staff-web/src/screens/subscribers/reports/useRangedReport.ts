import { reportUrl } from "./reportUrl";
import { useReport } from "./useReport";
import { useReportParams } from "./useReportParams";

/** A date-ranged report: the range and page come from the page URL; until staff pick one, the
 * server's default (the last 30 days) is shown and filled into the form. `formKey` changes only
 * with the range in the URL, never when a response lands, so a form keyed on it keeps whatever
 * staff are typing while a report loads. */
export function useRangedReport<T extends { from: string; to: string }>(path: string) {
  const params = useReportParams();
  const from = params.value("from");
  const to = params.value("to");
  const report = useReport<T>(reportUrl(path, { from, to, page: params.page > 1 ? params.page : undefined }));
  return {
    report,
    params,
    shown: { from: report.data?.from ?? from, to: report.data?.to ?? to },
    formKey: `${from}|${to}`,
    csvHref: (csvPath: string) => reportUrl(csvPath, { from: report.data?.from, to: report.data?.to }),
    apply: (f: string, t: string) => params.update({ from: f || null, to: t || null }),
  };
}
