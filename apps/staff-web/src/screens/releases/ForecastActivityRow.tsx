import { Link } from "react-router";
import type { ForecastActivity } from "@gcpe/nrms-contract";
import { formatWhen } from "../../format/dates";
import { activityPath } from "../calendar/activity/paths";

export interface ForecastActivityRowProps {
  activity: ForecastActivity;
  /** The activity's release time, or else its start. */
  at: string;
  now: Date;
  timeZone: string;
  /** NRMS Editors can start a release from it (parent spec §5 step 2). */
  canStartRelease: boolean;
}

/**
 * A Calendar activity on the Forecast (Releases.aspx:136-190): the green bar, its ministry and
 * categories, "Location - Title" linking to the activity, its details, "Planned for" (every Forecast
 * activity is confirmed) and its id.
 */
export function ForecastActivityRow({ activity: a, at, now, timeZone, canStartRelease }: ForecastActivityRowProps): React.JSX.Element {
  const title = `${a.location ? `${a.location} - ` : ""}${a.title || "(untitled)"}`;
  return (
    <li className="gcpe-release-row">
      <span className="gcpe-release-row__bar gcpe-release-row__bar--activity" aria-hidden="true" />
      <div className="gcpe-release-row__body">
        <p className="gcpe-release-row__meta">
          <span className="gcpe-release-row__type">Calendar activity</span>
          {a.ministryName && (
            <>
              {" "}
              &middot; <span>{a.ministryName}</span>
            </>
          )}
        </p>
        {a.categoryNames.length > 0 && <p className="gcpe-release-row__page-title">{a.categoryNames.join(", ")}</p>}
        <p className="gcpe-release-row__headline">
          <Link to={activityPath(a.activityId)}>{title}</Link>
        </p>
        {a.details && <p className="gcpe-release-row__summary">{a.details}</p>}
        <p className="gcpe-release-row__status">
          Planned for {formatWhen(at, now, timeZone)} &middot; Activity ID {a.activityId}
        </p>
        {canStartRelease && (
          <p>
            <Link to={`/releases/new?activity=${a.activityId}`}>Start a release</Link>
          </p>
        )}
      </div>
    </li>
  );
}
