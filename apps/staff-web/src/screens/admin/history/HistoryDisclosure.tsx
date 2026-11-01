import { useEffect, useState } from "react";
import { Accordion } from "@bcgov/design-system-react-components";
import { Button } from "../../../shared/BusyButton";
import { apiFetch } from "../../../api/client";
import { formatWhen } from "../../../format/dates";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { describeEntry, type AuditEntry, type AuditPage } from "./describe";

/** Entries per load; "Show older changes" fetches the next lot. */
export const HISTORY_PAGE_SIZE = 20;

export interface HistoryDisclosureProps {
  targetType: "user" | "organization";
  /** The user id or organization key. */
  targetId: string;
  /** Whose history it is, for the list's name: "Changes to Jo Lee, newest first". */
  name: string;
  /** Changes whenever the record does (after a save), so an open History reloads with the new entry. */
  version?: unknown;
  /** A ministry's name from its key, for Calendar access entries. */
  orgName?: (key: string) => string | undefined;
}

/**
 * Suite review O3: a user's or organization's changes in the Core admin screens, newest first,
 * closed until opened (and only fetched then), as Releases' History lists its log: when, who,
 * what. Core administrators only: the screens show it to nobody else, and Core refuses anyone else.
 */
export function HistoryDisclosure({ targetType, targetId, name, version, orgName }: HistoryDisclosureProps): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    const query = (page: number) => `/core/api/audit?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}&page=${page}&pageSize=${HISTORY_PAGE_SIZE}`;
    // Every page loaded so far, again: a new entry pushes the others down a place.
    Promise.all(Array.from({ length: pages }, (_, i) => apiFetch<AuditPage>(query(i + 1)))).then(
      (loaded) => {
        if (!active) return;
        setItems(loaded.flatMap((p) => p.items));
        setTotal(loaded[loaded.length - 1]?.total ?? 0);
        setError(false);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setError(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [open, pages, targetType, targetId, version]);

  const now = new Date();
  const when = (iso: string) => formatWhen(iso, now, timeZone, { withDate: true });
  return (
    <div className="gcpe-section-disclosure gcpe-audit-history">
      <Accordion label="History" isExpanded={open} onExpandedChange={setOpen}>
        <div className="gcpe-stack">
          {error && <p role="alert">Couldn&rsquo;t load the history.</p>}
          {items === null && !error && <p>Loading…</p>}
          {items !== null && items.length === 0 && <p>No changes recorded yet.</p>}
          {items !== null && items.length > 0 && (
            <ul aria-label={`Changes to ${name}, newest first`}>
              {items.map((e) => (
                <li key={e.id}>
                  {when(e.at)} — {e.actorName} {describeEntry(e, orgName, when)}
                </li>
              ))}
            </ul>
          )}
          {items !== null && items.length < total && (
            <Button size="small" variant="secondary" isPending={loading} onPress={() => setPages((p) => p + 1)}>
              Show older changes
            </Button>
          )}
        </div>
      </Accordion>
    </div>
  );
}
