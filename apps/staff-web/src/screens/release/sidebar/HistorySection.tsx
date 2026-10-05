import { useCallback, useEffect, useState } from "react";
import { Checkbox } from "@bcgov/design-system-react-components";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";

export interface HistorySectionProps {
  view: ReleaseView;
}

interface LogEntry {
  at: string;
  actorName: string;
  text: string;
}

interface Publication {
  id: number;
  publishedAt: string;
  actorName: string;
}

/** History (task-4-brief.md): the log (`GET .../log`, with a "Show all" toggle that adds
 * `?all=true` — without it, routine "Edited…"/"Updated…" entries are hidden server-side) and
 * the frozen-copy publications list (`GET .../publications`). Both are read-only and available
 * to every signed-in staff role, not just Editors. */
export function HistorySection({ view }: HistorySectionProps): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);

  const loadLog = useCallback((all: boolean) => {
    apiFetch<LogEntry[]>(`/nrms/api/releases/${view.id}/log${all ? "?all=true" : ""}`).then(setLog, () => {
      // The log just stays empty — the rest of the sidebar still works.
    });
  }, [view.id]);

  useEffect(() => loadLog(showAll), [loadLog, showAll]);

  useEffect(() => {
    apiFetch<Publication[]>(`/nrms/api/releases/${view.id}/publications`).then(setPublications, () => {});
  }, [view.id]);

  return (
    <div className="gcpe-sidebar__history">
      <h3>History</h3>
      <Checkbox isSelected={showAll} onChange={setShowAll}>
        Show all
      </Checkbox>
      <ul>
        {log.map((entry, i) => (
          <li key={i}>
            {entry.at} — {entry.actorName}: {entry.text}
          </li>
        ))}
        {log.length === 0 && <li>No history yet.</li>}
      </ul>

      <h3>Published copies</h3>
      <ul>
        {publications.map((p) => (
          <li key={p.id}>
            {p.publishedAt} — {p.actorName}
          </li>
        ))}
        {publications.length === 0 && <li>Never published.</li>}
      </ul>
    </div>
  );
}
