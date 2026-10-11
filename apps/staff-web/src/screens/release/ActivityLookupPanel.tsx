import { useEffect, useState } from "react";
import { Link } from "react-router";
import { MAX_ACTIVITY_ID, type ActivityLookup } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { dateTimeText } from "../calendar/list/dates";
import { activityPath } from "../calendar/activity/paths";

/** Looks `id` up in NRMS's copy of the Calendar's activities (spec addendum §11); null while there's nothing to show. */
export function useActivityLookup(id: number | null): ActivityLookup | null {
  const [result, setResult] = useState<ActivityLookup | null>(null);
  useEffect(() => {
    setResult(null);
    if (id === null || !Number.isInteger(id) || id < 1 || id > MAX_ACTIVITY_ID) return;
    let active = true;
    apiFetch<ActivityLookup>(`/nrms/api/calendar-activities/${id}`).then(
      (r) => {
        if (active) setResult(r);
      },
      (e: unknown) => {
        if (active && e instanceof ApiError && e.status === 404) setResult({ id, state: "unknown" });
      },
    );
    return () => {
      active = false;
    };
  }, [id]);
  return result;
}

export interface ActivityLookupPanelProps {
  lookup: ActivityLookup | null;
  /** The release's saved activity id: an unknown one is a legacy link that wasn't migrated (C158). */
  storedId: number | null;
  timeZone: string;
}

/** What the activity id names, under the field. A polite live region, so typing an id is announced once it resolves. */
export function ActivityLookupPanel({ lookup, storedId, timeZone }: ActivityLookupPanelProps): React.JSX.Element {
  return (
    <div role="status" className="gcpe-activity-lookup">
      {lookup && <LookupText lookup={lookup} storedId={storedId} timeZone={timeZone} />}
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
