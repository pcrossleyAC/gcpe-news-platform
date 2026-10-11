import { useEffect, useState } from "react";
import { Link } from "react-router";
import { MAX_ACTIVITY_ID, type ActivityLookup } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { dateTimeText } from "../calendar/list/dates";
import { activityPath } from "../calendar/activity/paths";

/** Looks `id` up in NRMS's copy of the Calendar's activities (spec addendum §11); `lookup` is
 * null while there's nothing to show. A 404 means no such activity (`lookup` becomes the
 * "unknown" state); any other failure (500, network, 403, …) sets `error` instead, so the
 * caller can tell "still looking up" from "the lookup failed" apart. */
export function useActivityLookup(id: number | null): { lookup: ActivityLookup | null; error: boolean } {
  const [result, setResult] = useState<ActivityLookup | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    setResult(null);
    setError(false);
    if (id === null || !Number.isInteger(id) || id < 1 || id > MAX_ACTIVITY_ID) return;
    let active = true;
    apiFetch<ActivityLookup>(`/nrms/api/calendar-activities/${id}`).then(
      (r) => {
        if (active) setResult(r);
      },
      (e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) setResult({ id, state: "unknown" });
        else setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [id]);
  return { lookup: result, error };
}

export interface ActivityLookupPanelProps {
  lookup: ActivityLookup | null;
  /** True on a non-404 lookup failure. Shown as a short generic message -- never the error
   * detail, which might carry anything the server or network happened to say. */
  error: boolean;
  /** The release's saved activity id: an unknown one is a legacy link that wasn't migrated (C158). */
  storedId: number | null;
  timeZone: string;
}

/** What the activity id names, under the field. A polite live region, so typing an id is announced once it resolves. */
export function ActivityLookupPanel({ lookup, error, storedId, timeZone }: ActivityLookupPanelProps): React.JSX.Element {
  return (
    <div role="status" className="gcpe-activity-lookup">
      {error && <p role="alert">Couldn&rsquo;t look up that activity — try again.</p>}
      {!error && lookup && <LookupText lookup={lookup} storedId={storedId} timeZone={timeZone} />}
    </div>
  );
}

function LookupText({ lookup: l, storedId, timeZone }: { lookup: ActivityLookup; storedId: number | null; timeZone: string }): React.JSX.Element {
  if (l.state !== "found") {
    if (l.state === "deleted") return <p>Calendar activity {l.id} has been deleted.</p>;
    if (l.state === "hidden") return <p>Calendar activity {l.id}: its details aren&rsquo;t shown to you.</p>;
    return <p>{l.id === storedId ? `Legacy activity ${l.id}, not migrated` : `No Calendar activity has ID ${l.id}.`}</p>;
  }
  return (
    <>
      <p>
        <Link to={activityPath(l.id)}>{l.title || "(untitled)"}</Link>
        {l.ministryName && ` · ${l.ministryName}`}
        {l.startAt && ` · ${dateTimeText(l.startAt, timeZone)}`}
      </p>
      {l.translations.length > 0 && <p>Translations required: {l.translations.join(", ")}</p>}
      {l.notEligible && <p>{l.notEligible}</p>}
    </>
  );
}
