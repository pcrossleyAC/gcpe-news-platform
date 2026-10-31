import { Link } from "react-router";
import { TYPE_LABEL, type ReleaseType } from "@gcpe/nrms-contract";
import type { ReleaseLinkView } from "@gcpe/calendar-contract";
import { dateTimeText } from "../list/dates";

const STATUS: Record<string, string> = {
  draft: "Draft", approved: "Approved", scheduled: "Scheduled", publishing: "Publishing", published: "Published", unpublishing: "Unpublishing", failed: "Failed",
};

/** "Release 2031HLTH0001: Scheduled, Nov 10, 2031 9:00 AM": the release's type, reference, status and time. */
export function releaseLabel(r: ReleaseLinkView, timeZone: string): string {
  const at = r.releasedAt ?? r.publishAt;
  return `${TYPE_LABEL[r.type as ReleaseType] ?? r.type}${r.reference ? ` ${r.reference}` : ""}: ${STATUS[r.status] ?? r.status}${at ? `, ${dateTimeText(at, timeZone)}` : ""}`;
}

/** Statuses of a release that is still to go out: changing the activity's timing doesn't move it. */
const NOT_OUT = new Set(["draft", "approved", "scheduled", "publishing", "failed"]);
export const plannedReleases = (releases: readonly ReleaseLinkView[]) => releases.filter((r) => NOT_OUT.has(r.status));

/** "BC Gov News" (spec addendum §8.2, §11): the releases linked to this activity. The link is for NRMS users; NRMS guards the release itself. */
export function ReleasesList({ releases, timeZone, canOpen }: { releases: readonly ReleaseLinkView[]; timeZone: string; canOpen: boolean }): React.JSX.Element {
  return (
    <section aria-labelledby="bc-gov-news" className="gcpe-release-links">
      <h2 id="bc-gov-news">BC Gov News</h2>
      {releases.length === 0 ? (
        <p>No releases are linked to this activity.</p>
      ) : (
        <ul>
          {releases.map((r) => {
            const label = releaseLabel(r, timeZone);
            return (
              <li key={r.releaseId}>
                <span className={`gcpe-release-swatch gcpe-release-swatch--${r.type}`} aria-hidden="true" />
                {canOpen ? <Link to={`/releases/${r.releaseId}`}>{label}</Link> : label}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
