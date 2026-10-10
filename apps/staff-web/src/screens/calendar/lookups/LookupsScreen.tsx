import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import type { LookupSummary } from "./types";

/** `/hub/calendar/lookups`: every lookup (spec addendum §5.3). Locked ones are read-only below System Administrator. */
export function LookupsScreen(): React.JSX.Element {
  useDocumentTitle("Calendar lookups");
  const [lookups, setLookups] = useState<LookupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    const call = ++latest.current;
    apiFetch<LookupSummary[]>("/calendar/api/lookups").then(
      (l) => {
        if (call === latest.current) setLookups(l);
      },
      () => {
        if (call === latest.current) setError("Couldn't load the lookups.");
      },
    );
  }, []);
  return (
    <div>
      <h1>Calendar lookups</h1>
      <p>The choices offered on activities. Rows are never deleted; deactivate a row to stop offering it.</p>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {lookups === null && !error && <p>Loading…</p>}
      <ul className="gcpe-link-grid">
        {(lookups ?? []).map((l) => (
          <li key={l.name}>
            <Link to={`/calendar/lookups/${l.name}`}>{l.editable ? l.label : `${l.label} (read only)`}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
