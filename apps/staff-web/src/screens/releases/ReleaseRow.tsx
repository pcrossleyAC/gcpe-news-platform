import { Link } from "react-router";
import { TYPE_LABEL, type ReleaseListItem, type ReleaseType } from "@gcpe/nrms-contract";
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

/** Words only, lower case: "KAMLOOPS –" and "Kamloops -" compare equal. */
const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * `LOCATION – summary`, except when the summary already opens with the location (the summary is
 * often generated from the body, whose first words are the dateline): then just the summary, so
 * a row never reads "KAMLOOPS – KAMLOOPS - …". Compared by whole words, ignoring case and
 * punctuation, so "VICTORIA" doesn't swallow a summary starting "Victorians".
 */
export function datelineText(location: string, summary: string): string {
  const loc = words(location);
  const sum = words(summary);
  if (loc && sum && (sum === loc || sum.startsWith(`${loc} `))) return summary;
  return [location, summary].filter((part) => part !== "").join(" – ");
}

/** Each type's own name and its standard page title (the legacy page-title list's wording): a
 * page title that is exactly one of these only restates the type already shown. */
const TYPE_RESTATEMENTS: Record<ReleaseType, string[]> = {
  release: ["News Release"],
  story: ["News Story"],
  factsheet: ["Fact Sheet", "Factsheet"],
  update: ["Update"],
  advisory: ["Media Advisory"],
};

/** The page title, unless it's exactly a restatement of the type ("News Release" on a
 * Release). Anything more ("Joint News Release") says something the type doesn't. */
function pageTitleShown(pageTitle: string, type: ReleaseType): boolean {
  if (!pageTitle) return false;
  const t = words(pageTitle);
  return ![TYPE_LABEL[type], ...TYPE_RESTATEMENTS[type]].some((r) => words(r) === t);
}

/** One row of a Drafts/Scheduled/Published list or a search result (spec §5/§8): colour bar,
 * one meta line (type label · page title · lead organisation · status · date · Calendar
 * activity id, with the Approved/Flickr-alert badges), the headline linking to the release,
 * and the `LOCATION – summary` dateline clamped to two lines. Shared between the release lists
 * and search so both stay visually identical. */
export function ReleaseRow({ item, now, timeZone }: ReleaseRowProps): React.JSX.Element {
  // Scheduled/Drafts show the planned publishAt; Published shows the actual releasedAt
  // (constraints.md / codemap §8).
  const dateIso = item.status === "published" ? item.releasedAt : item.publishAt;
  const when = dateIso ? formatWhen(dateIso, now, timeZone) : null;

  const dateline = datelineText(item.location, item.summary);
  const typeLabel = TYPE_LABEL[item.type];

  // The Approved badge is specific to the Drafts folder (brief: "'Approved' badge on drafts
  // with a reference") — `approved` itself (reference !== null) stays true after the release
  // moves on to Scheduled/Published, where it's no longer shown. Legacy shows the badge
  // whenever the reference is set, including on a failed release (fix round 1). When the status
  // itself already reads "Approved", the badge would only repeat it, so it's left off.
  const showApprovedBadge = item.approved && DRAFT_FOLDER_STATUSES.includes(item.status) && item.statusText.toLowerCase() !== "approved";
  const flickrAlertId = item.flickrAlert ? `flickr-alert-${item.id}` : undefined;
  const sep = " · ";

  return (
    <li className="gcpe-release-row">
      <span className={`gcpe-release-row__bar gcpe-release-row__bar--${item.type}`} aria-hidden="true" />
      <div className="gcpe-release-row__body">
        <p className="gcpe-release-row__meta">
          <span className="gcpe-release-row__type">{typeLabel}</span>
          {pageTitleShown(item.pageTitle, item.type) && (
            <>
              {sep}
              <span className="gcpe-release-row__page-title">{item.pageTitle}</span>
            </>
          )}
          {item.leadOrganization && (
            <>
              {sep}
              <span>{item.leadOrganization}</span>
            </>
          )}
          {sep}
          <span className="gcpe-badge gcpe-release-row__status-text">{item.statusText}</span>
          {showApprovedBadge && <span className="gcpe-badge gcpe-release-row__approved">Approved</span>}
          {item.flickrAlert && (
            <span className="gcpe-badge gcpe-badge--alert" aria-describedby={flickrAlertId}>
              Flickr alert
              <span id={flickrAlertId} className="gcpe-visually-hidden">
                {item.flickrAlert}
              </span>
            </span>
          )}
          {when && (
            <>
              {sep}
              <span>{when}</span>
            </>
          )}
          {item.activityId != null && (
            <>
              {sep}
              <span>Calendar activity {item.activityId}</span>
            </>
          )}
        </p>
        <h2 className="gcpe-release-row__headline">
          <Link to={`/releases/${item.id}`}>{item.headline || "(untitled)"}</Link>
        </h2>
        {dateline && <p className="gcpe-release-row__summary">{dateline}</p>}
      </div>
    </li>
  );
}
