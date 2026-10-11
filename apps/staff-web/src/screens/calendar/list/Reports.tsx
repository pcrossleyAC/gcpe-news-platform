import { useEffect, useRef, useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import { REPORT_KINDS, REPORT_LABELS, type ListQuery, type ReportKind } from "@gcpe/calendar-contract";
import { runReport, type ReportCancellation } from "./api";

/**
 * The list toolbar's reports (spec addendum §8.1, §10): Look Ahead, Exec Look Ahead (HQ
 * Administrators), 30/60/90 and Planning, each a PDF of the list's current query. One at a time.
 * Polling for a report still being prepared stops with no further effect once this unmounts
 * (the user navigated away) — it never sets state, or starts another poll, after that.
 */
export function ReportButtons({ query, execLookAhead }: { query: ListQuery; execLookAhead: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState<ReportKind | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancellation = useRef<ReportCancellation>({ aborted: false });
  useEffect(
    () => () => {
      cancellation.current.aborted = true;
    },
    [],
  );
  const run = async (report: ReportKind) => {
    setBusy(report);
    setStatus(null);
    setError(null);
    const signal = cancellation.current;
    try {
      await runReport(report, query, { signal });
      if (signal.aborted) return;
      setStatus(`The ${REPORT_LABELS[report]} report has downloaded.`);
    } catch (caught) {
      if (signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "The report couldn't be prepared. Try again.");
    } finally {
      if (!signal.aborted) setBusy(null);
    }
  };
  const kinds = REPORT_KINDS.filter((k) => k !== "exec-look-ahead" || execLookAhead);
  return (
    <div role="group" aria-label="Reports (PDF)">
      {kinds.map((k) => (
        <Button key={k} variant="secondary" isDisabled={busy !== null} onPress={() => void run(k)}>
          {REPORT_LABELS[k]}
        </Button>
      ))}
      {busy && <p role="status">{`Preparing your ${REPORT_LABELS[busy]} report…`}</p>}
      {!busy && status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
