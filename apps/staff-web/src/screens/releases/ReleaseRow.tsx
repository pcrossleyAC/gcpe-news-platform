import { Link } from "react-router";
import { TYPE_LABEL, type ReleaseListItem } from "@gcpe/nrms-contract";
import { formatWhen } from "../../format/dates";

/** The Drafts folder's statuses (apps/nrms/src/releases/queries.ts's FOLDER_STATUSES.drafts) —
 * the Approved badge is specific to this folder. */
const DRAFT_FOLDER_STATUSES: readonly string[] = ["draft", "approved", "failed"];

export interface ReleaseRowProps {
  item: ReleaseListItem;
  /** "Now", for {@link formatWhen}'s relative wording — passed in (not read with `new Date()`
   * per row) so every row on a page agrees on what day it is. */
  now: Date;
  timeZone: string;
}

/** One row of a Drafts/Scheduled/Published list or a search result (spec §5/§8): colour bar +
 * type label, lead organisation, page title, headline (linking to the release), `LOCATION –
 * summary`, status text + relative date, Calendar activity id, and the Approved/Flickr-alert
 * badges. Shared between the release lists and search so both stay visually identical. */
export function ReleaseRow({ item, now, timeZone }: ReleaseRowProps): React.JSX.Element {
  // Scheduled/Drafts show the planned publishAt; Published shows the actual releasedAt
  // (constraints.md / codemap §8).
  const dateIso = item.status === "published" ? item.releasedAt : item.publishAt;
  const when = dateIso ? formatWhen(dateIso, now, timeZone) : null;

  const locationSummary = [item.location, item.summary].filter((part) => part !== "").join(" – ");

  // The Approved badge is specific to the Drafts folder (brief: "'Approved' badge on drafts
  // with a reference") — `approved` itself (reference !== null) stays true after the release
  // moves on to Scheduled/Published, where it's no longer shown. Legacy shows the badge
  // whenever the reference is set, including on a failed release (fix round 1).
  const showApprovedBadge = item.approved && DRAFT_FOLDER_STATUSES.includes(item.status);
  const flickrAlertId = item.flickrAlert ? `flickr-alert-${item.id}` : undefined;

  return (
    <li className="gcpe-release-row">
      <span className={`gcpe-release-row__bar gcpe-release-row__bar--${item.type}`} aria-hidden="true" />
      <div className="gcpe-release-row__body">
        <p className="gcpe-release-row__meta">
          <span className="gcpe-release-row__type">{TYPE_LABEL[item.type]}</span>
          {item.leadOrganization && (
            <>
              {" "}
              &middot; <span>{item.leadOrganization}</span>
            </>
          )}
        </p>
        {item.pageTitle && <p className="gcpe-release-row__page-title">{item.pageTitle}</p>}
        <p className="gcpe-release-row__headline">
          <Link to={`/releases/${item.id}`}>{item.headline || "(untitled)"}</Link>
        </p>
        {locationSummary && <p className="gcpe-release-row__summary">{locationSummary}</p>}
        <p className="gcpe-release-row__status">
          <span className="gcpe-release-row__status-text">{item.statusText}</span>
          {when && (
            <>
              {" "}
              &middot; <span>{when}</span>
            </>
          )}
          {item.activityId != null && (
            <>
              {" "}
              &middot; <span>Calendar activity {item.activityId}</span>
            </>
          )}
        </p>
        {(showApprovedBadge || item.flickrAlert) && (
          <p className="gcpe-release-row__badges">
            {showApprovedBadge && <span className="gcpe-badge">Approved</span>}
            {item.flickrAlert && (
              <span className="gcpe-badge gcpe-badge--alert" aria-describedby={flickrAlertId}>
                Flickr alert
                <span id={flickrAlertId} className="gcpe-visually-hidden">
                  {item.flickrAlert}
                </span>
              </span>
            )}
          </p>
        )}
      </div>
    </li>
  );
}
